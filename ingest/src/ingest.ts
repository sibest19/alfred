// Turns Baileys events into rows. Every write is idempotent (keyed by WhatsApp ids), so replays,
// history sync overlapping live messages, and restarts never duplicate anything.
import {
  BufferJSON,
  WAMessageStubType,
  getContentType,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  isLidUser,
  isPnUser,
  jidNormalizedUser,
  normalizeMessageContent,
  proto,
  toNumber,
  type Chat,
  type ChatUpdate,
  type Contact,
  type GroupMetadata,
  type GroupParticipant,
  type LIDMapping,
  type WAMessage,
  type WAMessageKey,
} from 'baileys';
import type { Logger } from 'pino';
import { config } from './config.js';
import type { Sql } from '@alfred/db';
import { metrics } from './metrics.js';

export type Source = 'live' | 'append' | 'history';

type MediaInfo = {
  kind: string;
  mimetype: string | null;
  file_name: string | null;
  file_length: number | null;
  seconds: number | null;
  voice_note: boolean;
};

type Described =
  | { skip: true }
  | {
      skip: false;
      type: string;
      body: string | null;
      quoted: string | null;
      forwarded: boolean;
      media: MediaInfo | null;
    };

// Content types that are not messages of their own: protocol traffic, votes, key distribution.
// Edits and revokes arrive as protocolMessage and are applied through messages.update.
const NOT_A_MESSAGE = new Set([
  'protocolMessage',
  'reactionMessage',
  'encReactionMessage',
  'pollUpdateMessage',
  'senderKeyDistributionMessage',
  'keepInChatMessage',
  'pinInChatMessage',
  'messageHistoryBundle',
]);

const MEDIA_KIND: Record<string, string> = {
  imageMessage: 'image',
  videoMessage: 'video',
  ptvMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  stickerMessage: 'sticker',
};

const num = (v: unknown): number | null => (v === null || v === undefined ? null : toNumber(v as number));

/** Postgres rejects NUL in text and jsonb. */
const clean = (s: string | null | undefined): string | null => (s ? s.replace(/\u0000/g, '') : (s ?? null));

/** The WAMessage as JSON with Baileys' Buffer encoding, ready for a jsonb column. */
export const toJson = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, BufferJSON.replacer).replace(/\\u0000/g, ''));
export const fromJson = <T>(value: unknown): T => JSON.parse(JSON.stringify(value), BufferJSON.reviver);

function bodyOf(type: string, c: any): string | null {
  switch (type) {
    case 'conversation':
      return c.conversation ?? null;
    case 'extendedTextMessage':
      return c.extendedTextMessage?.text ?? null;
    case 'imageMessage':
    case 'videoMessage':
    case 'ptvMessage':
      return c[type]?.caption ?? null;
    case 'documentMessage':
      return c.documentMessage?.caption || c.documentMessage?.fileName || null;
    case 'contactMessage':
      return c.contactMessage?.displayName ? `contact: ${c.contactMessage.displayName}` : null;
    case 'contactsArrayMessage':
      return `contacts: ${(c.contactsArrayMessage?.contacts ?? []).map((x: any) => x.displayName).join(', ')}`;
    case 'locationMessage':
    case 'liveLocationMessage': {
      const l = c[type];
      const where = [l?.name, l?.address].filter(Boolean).join(', ');
      return `location: ${where ? where + ' ' : ''}(${l?.degreesLatitude}, ${l?.degreesLongitude})`;
    }
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3': {
      const p = c[type];
      return [`poll: ${p?.name ?? ''}`, ...(p?.options ?? []).map((o: any) => `- ${o.optionName}`)].join('\n');
    }
    case 'eventMessage':
      return [c.eventMessage?.name, c.eventMessage?.description].filter(Boolean).join('\n') || null;
    default:
      return c[type]?.text ?? c[type]?.caption ?? null;
  }
}

export function describe(msg: WAMessage): Described {
  const content = normalizeMessageContent(msg.message);
  if (!content) {
    const stub = msg.messageStubType;
    if (stub === WAMessageStubType.CIPHERTEXT) {
      return { skip: false, type: 'ciphertext', body: null, quoted: null, forwarded: false, media: null };
    }
    if (!stub) return { skip: true };
    const name = WAMessageStubType[stub] ?? String(stub);
    const body = [name, ...(msg.messageStubParameters ?? [])].join(' ');
    return { skip: false, type: 'stub', body, quoted: null, forwarded: false, media: null };
  }
  const type = getContentType(content);
  if (!type || NOT_A_MESSAGE.has(type)) return { skip: true };
  const inner = (content as any)[type] ?? {};
  const ctx = inner.contextInfo;
  const kind = MEDIA_KIND[type];
  const media: MediaInfo | null = kind
    ? {
        kind,
        mimetype: inner.mimetype ?? null,
        file_name: inner.fileName ?? null,
        file_length: num(inner.fileLength),
        seconds: inner.seconds ?? null,
        voice_note: type === 'audioMessage' && !!inner.ptt,
      }
    : null;
  return {
    skip: false,
    type,
    body: clean(bodyOf(type, content)),
    quoted: ctx?.stanzaId ?? null,
    forwarded: !!ctx?.isForwarded,
    media,
  };
}

const chatKind = (jid: string) => (isJidGroup(jid) ? 'group' : isJidBroadcast(jid) ? 'broadcast' : 'user');

/** Chats we never archive: status updates and channels. */
export const ignoredJid = (jid: string | undefined | null) =>
  !jid || isJidStatusBroadcast(jid) || !!isJidNewsletter(jid);

export class Ingest {
  private lidToPn = new Map<string, string>();
  private me: { pn?: string; lid?: string } = {};
  /** Group metadata for Baileys' cachedGroupMetadata (saves a query per group send/retry). */
  readonly groups = new Map<string, GroupMetadata>();

  constructor(
    private sql: Sql,
    private log: Logger,
  ) {}

  async init() {
    const rows = await this.sql<{ lid: string; pn: string }[]>`SELECT lid, pn FROM lid_map`;
    for (const r of rows) this.lidToPn.set(r.lid, r.pn);
  }

  setMe(me: { id: string; lid?: string } | undefined) {
    if (!me) return;
    this.me = { pn: jidNormalizedUser(me.id), lid: me.lid ? jidNormalizedUser(me.lid) : undefined };
    if (this.me.lid && this.me.pn) this.lidToPn.set(this.me.lid, this.me.pn);
  }

  /** Normalized JID, in phone form when the LID's phone number is known. */
  resolve(jid: string | null | undefined, alt?: string | null): string | undefined {
    if (!jid) return undefined;
    const j = jidNormalizedUser(jid);
    if (isLidUser(j)) {
      const a = alt ? jidNormalizedUser(alt) : undefined;
      if (a && isPnUser(a)) return a;
      return this.lidToPn.get(j) ?? j;
    }
    return j;
  }

  async addLidMappings(list: (LIDMapping | undefined)[]) {
    const rows: { lid: string; pn: string }[] = [];
    for (const m of list) {
      if (!m?.lid || !m?.pn) continue;
      const lid = jidNormalizedUser(m.lid);
      const pn = jidNormalizedUser(m.pn);
      if (!isLidUser(lid) || !isPnUser(pn) || this.lidToPn.get(lid) === pn) continue;
      this.lidToPn.set(lid, pn);
      rows.push({ lid, pn });
    }
    if (rows.length === 0) return;
    const unique = [...new Map(rows.map((r) => [r.lid, r])).values()];
    await this.sql`
      INSERT INTO lid_map ${this.sql(unique, 'lid', 'pn')}
      ON CONFLICT (lid) DO UPDATE SET pn = EXCLUDED.pn, updated_at = now()`;
  }

  /** Mappings carried by a message key (v7 sends the other form of the JID as *Alt). */
  private keyMappings(key: WAMessageKey): LIDMapping[] {
    const out: LIDMapping[] = [];
    const pair = (a?: string | null, b?: string | null) => {
      if (!a || !b) return;
      const [x, y] = [jidNormalizedUser(a), jidNormalizedUser(b)];
      if (isLidUser(x) && isPnUser(y)) out.push({ lid: x, pn: y });
      else if (isPnUser(x) && isLidUser(y)) out.push({ lid: y, pn: x });
    };
    pair(key.remoteJid, key.remoteJidAlt);
    pair(key.participant, key.participantAlt);
    return out;
  }

  private sender(key: WAMessageKey, chat: string): string | undefined {
    if (key.fromMe) return this.me.pn ?? this.resolve(key.participant ?? key.remoteJid);
    if (isJidGroup(chat) || isJidBroadcast(chat)) return this.resolve(key.participant, key.participantAlt);
    return chat;
  }

  async storeMessages(messages: WAMessage[], source: Source) {
    await this.addLidMappings(messages.flatMap((m) => (m.key ? this.keyMappings(m.key) : [])));

    const rows: Record<string, any>[] = [];
    const media = new Map<string, MediaInfo & { sent_at: Date }>();
    const reactions: any[] = [];

    for (const msg of messages) {
      const key = msg.key;
      if (!key?.id || ignoredJid(key.remoteJid)) continue;
      const chat = this.resolve(key.remoteJid, key.remoteJidAlt);
      if (!chat) continue;
      const sender = this.sender(key, chat);
      const ts = num(msg.messageTimestamp);
      const sentAt = ts ? new Date(ts * 1000) : new Date();

      // History carries the reactions a message received; live reactions arrive as their own message.
      for (const r of msg.reactions ?? []) {
        const who = r.key?.fromMe ? this.me.pn : this.resolve(r.key?.participant ?? r.key?.remoteJid);
        if (who) reactions.push(this.reactionRow(key.id, chat, who, r.text, num(r.senderTimestampMs)));
      }
      const reaction = normalizeMessageContent(msg.message)?.reactionMessage;
      if (reaction?.key?.id && sender) {
        reactions.push(this.reactionRow(reaction.key.id, chat, sender, reaction.text, num(reaction.senderTimestampMs)));
        continue;
      }

      const d = describe(msg);
      if (d.skip) continue;
      if (d.type === 'ciphertext') metrics.decryptFailures.inc();
      rows.push({
        msg_id: key.id,
        chat_jid: chat,
        from_me: !!key.fromMe,
        sender_jid: sender ?? null,
        push_name: clean(msg.pushName),
        sent_at: sentAt,
        type: d.type,
        body: d.body,
        quoted_msg_id: d.quoted,
        forwarded: d.forwarded,
        source,
        raw: this.sql.json(toJson(msg) as any),
      });
      if (d.media) media.set(key.id, { ...d.media, sent_at: sentAt });
    }

    let stored = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      // A ciphertext stub is replaced when the message later decrypts (Baileys retries).
      const written = await this.sql<{ id: string; msg_id: string }[]>`
        INSERT INTO messages ${this.sql(batch, 'msg_id', 'chat_jid', 'from_me', 'sender_jid', 'push_name', 'sent_at', 'type', 'body', 'quoted_msg_id', 'forwarded', 'source', 'raw')}
        ON CONFLICT (msg_id) DO UPDATE SET
          type = EXCLUDED.type, body = EXCLUDED.body, quoted_msg_id = EXCLUDED.quoted_msg_id,
          forwarded = EXCLUDED.forwarded, raw = EXCLUDED.raw,
          push_name = coalesce(EXCLUDED.push_name, messages.push_name)
        WHERE messages.type = 'ciphertext' AND EXCLUDED.type <> 'ciphertext'
        RETURNING id, msg_id`;
      stored += written.length;
      const mediaRows = written.flatMap((w) => {
        const m = media.get(w.msg_id);
        return m ? [{ message_id: w.id, ...this.mediaPlan(m, source) }] : [];
      });
      if (mediaRows.length > 0) {
        await this.sql`
          INSERT INTO media ${this.sql(mediaRows, 'message_id', 'kind', 'mimetype', 'file_name', 'file_length', 'seconds', 'voice_note', 'status', 'last_error')}
          ON CONFLICT (message_id) DO NOTHING`;
      }
    }
    if (stored > 0) metrics.messages.inc({ source }, stored);

    // Last activity per chat.
    const last = new Map<string, Date>();
    for (const r of rows) if (!(last.get(r.chat_jid)! >= r.sent_at)) last.set(r.chat_jid, r.sent_at);
    if (last.size > 0) {
      const chatRows = [...last].map(([jid, at]) => ({ jid, kind: chatKind(jid), last_message_at: at }));
      await this.sql`
        INSERT INTO chats ${this.sql(chatRows, 'jid', 'kind', 'last_message_at')}
        ON CONFLICT (jid) DO UPDATE SET
          last_message_at = greatest(chats.last_message_at, EXCLUDED.last_message_at), updated_at = now()`;
    }
    if (source === 'live') {
      const newest = rows.filter((r) => !r.from_me).reduce((t, r) => Math.max(t, r.sent_at.getTime()), 0);
      if (newest > 0) metrics.lastLive.set(newest / 1000);
    }
    await this.storeReactions(reactions);
    return stored;
  }

  private mediaPlan(m: MediaInfo & { sent_at: Date }, source: Source) {
    const { sent_at, ...info } = m;
    let status = 'pending';
    let last_error: string | null = null;
    if (m.file_length !== null && m.file_length > config.mediaMaxBytes) {
      status = 'skipped';
      last_error = `larger than ${config.mediaMaxBytes} bytes`;
    } else if (source === 'history' && Date.now() - sent_at.getTime() > config.mediaHistoryDays * 86_400_000) {
      status = 'skipped';
      last_error = `history older than ${config.mediaHistoryDays} days`;
    }
    return { ...info, status, last_error };
  }

  private reactionRow(target: string, chat: string, sender: string, emoji: string | null | undefined, ms: number | null) {
    return {
      target_msg_id: target,
      chat_jid: chat,
      sender_jid: sender,
      emoji: clean(emoji) ?? '',
      reacted_at: ms ? new Date(ms) : new Date(),
    };
  }

  async storeReactions(rows: ReturnType<Ingest['reactionRow']>[]) {
    if (rows.length === 0) return;
    // Latest reaction per (message, sender) wins; an empty emoji removes it.
    const latest = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      const k = `${r.target_msg_id}|${r.sender_jid}`;
      if (!(latest.get(k)?.reacted_at! > r.reacted_at)) latest.set(k, r);
    }
    const set = [...latest.values()].filter((r) => r.emoji);
    const removed = [...latest.values()].filter((r) => !r.emoji);
    if (set.length > 0) {
      await this.sql`
        INSERT INTO reactions ${this.sql(set, 'target_msg_id', 'chat_jid', 'sender_jid', 'emoji', 'reacted_at')}
        ON CONFLICT (target_msg_id, sender_jid) DO UPDATE SET emoji = EXCLUDED.emoji, reacted_at = EXCLUDED.reacted_at
        WHERE EXCLUDED.reacted_at >= reactions.reacted_at`;
    }
    for (const r of removed) {
      await this.sql`
        DELETE FROM reactions
        WHERE target_msg_id = ${r.target_msg_id} AND sender_jid = ${r.sender_jid} AND reacted_at <= ${r.reacted_at}`;
    }
  }

  /** messages.reaction: the target key, and the reaction whose key is the reactor's message. */
  async onReactions(list: { key: WAMessageKey; reaction: proto.IReaction }[]) {
    const rows = [];
    for (const { key, reaction } of list) {
      if (!key.id || ignoredJid(key.remoteJid)) continue;
      const chat = this.resolve(key.remoteJid, key.remoteJidAlt);
      const rk = reaction.key;
      const who = rk?.fromMe ? this.me.pn : this.resolve(rk?.participant ?? rk?.remoteJid);
      if (chat && who) rows.push(this.reactionRow(key.id, chat, who, reaction.text, num(reaction.senderTimestampMs)));
    }
    await this.storeReactions(rows);
  }

  async applyEdit(key: WAMessageKey, edited: proto.IMessage, ts: number | null) {
    if (!key.id) return;
    const d = describe({ key, message: edited } as WAMessage);
    const body = d.skip ? null : d.body;
    const at = ts ? new Date(ts * 1000) : new Date();
    const res = await this.sql`
      WITH old AS (SELECT id, body FROM messages WHERE msg_id = ${key.id} FOR UPDATE),
      upd AS (
        UPDATE messages m SET body = ${body}, edited_at = ${at}, revision = m.revision + 1
        FROM old WHERE m.id = old.id AND m.body IS DISTINCT FROM ${body} RETURNING m.id
      )
      INSERT INTO message_revisions (message_id, kind, prev_body, new_body, changed_at)
      SELECT old.id, 'edit', old.body, ${body}, ${at} FROM old JOIN upd ON upd.id = old.id`;
    if (res.count === 0) this.log.debug({ msgId: key.id }, 'edit for a message not in the archive');
  }

  async applyRevoke(key: WAMessageKey) {
    if (!key.id) return;
    await this.sql`
      WITH upd AS (
        UPDATE messages SET deleted_at = now() WHERE msg_id = ${key.id} AND deleted_at IS NULL RETURNING id, body
      )
      INSERT INTO message_revisions (message_id, kind, prev_body, new_body, changed_at)
      SELECT id, 'delete', body, NULL, now() FROM upd`;
  }

  async upsertContacts(list: Partial<Contact>[]) {
    await this.addLidMappings(
      list.map((c) => {
        const lid = c.lid ?? (c.id && isLidUser(c.id) ? c.id : undefined);
        const pn = c.phoneNumber ?? (c.id && isPnUser(c.id) ? c.id : undefined);
        return lid && pn ? { lid, pn } : undefined;
      }),
    );
    const rows = new Map<string, Record<string, any>>();
    for (const c of list) {
      const jid = this.resolve(c.id, c.phoneNumber);
      if (!jid || ignoredJid(jid) || isJidGroup(jid)) continue;
      rows.set(jid, {
        jid,
        lid: c.lid ? jidNormalizedUser(c.lid) : isLidUser(c.id!) ? jidNormalizedUser(c.id!) : null,
        pn: isPnUser(jid) ? jid : null,
        name: clean(c.name),
        notify: clean(c.notify),
        verified_name: clean(c.verifiedName),
        username: clean(c.username),
      });
    }
    if (rows.size === 0) return;
    await this.sql`
      INSERT INTO contacts ${this.sql([...rows.values()], 'jid', 'lid', 'pn', 'name', 'notify', 'verified_name', 'username')}
      ON CONFLICT (jid) DO UPDATE SET
        lid = coalesce(EXCLUDED.lid, contacts.lid), pn = coalesce(EXCLUDED.pn, contacts.pn),
        name = coalesce(EXCLUDED.name, contacts.name), notify = coalesce(EXCLUDED.notify, contacts.notify),
        verified_name = coalesce(EXCLUDED.verified_name, contacts.verified_name),
        username = coalesce(EXCLUDED.username, contacts.username), updated_at = now()`;
  }

  async upsertChats(list: (Partial<Chat> | ChatUpdate)[]) {
    const rows = new Map<string, Record<string, any>>();
    for (const c of list) {
      const jid = this.resolve(c.id);
      if (!jid || ignoredJid(jid)) continue;
      rows.set(jid, {
        jid,
        kind: chatKind(jid),
        name: clean(c.name),
        archived: c.archived ?? null,
        unread_count: c.unreadCount ?? null,
      });
    }
    if (rows.size === 0) return;
    await this.sql`
      INSERT INTO chats ${this.sql([...rows.values()], 'jid', 'kind', 'name', 'archived', 'unread_count')}
      ON CONFLICT (jid) DO UPDATE SET
        name = coalesce(EXCLUDED.name, chats.name), archived = coalesce(EXCLUDED.archived, chats.archived),
        unread_count = coalesce(EXCLUDED.unread_count, chats.unread_count), updated_at = now()`;
  }

  /** Group metadata; with participants (a full fetch) the member list is replaced. */
  async upsertGroups(list: Partial<GroupMetadata>[]) {
    for (const g of list) {
      if (!g.id) continue;
      const jid = jidNormalizedUser(g.id);
      if (g.participants && g.subject !== undefined) this.groups.set(jid, g as GroupMetadata);
      else this.groups.delete(jid); // partial update: let Baileys refetch on demand
      const meta = {
        desc: g.desc,
        owner: this.resolve(g.owner, g.ownerPn),
        creation: g.creation,
        announce: g.announce,
        restrict: g.restrict,
        isCommunity: g.isCommunity,
        linkedParent: g.linkedParent,
        size: g.size ?? g.participants?.length,
      };
      const hasMeta = Object.values(meta).some((v) => v !== undefined);
      await this.sql`
        INSERT INTO chats (jid, kind, name, meta)
        VALUES (${jid}, 'group', ${clean(g.subject)}, ${hasMeta ? this.sql.json(toJson(meta) as any) : null})
        ON CONFLICT (jid) DO UPDATE SET
          name = coalesce(EXCLUDED.name, chats.name),
          meta = CASE WHEN EXCLUDED.meta IS NULL THEN chats.meta ELSE coalesce(chats.meta, '{}'::jsonb) || EXCLUDED.meta END,
          updated_at = now()`;
      if (g.participants) await this.replaceParticipants(jid, g.participants);
    }
  }

  private async replaceParticipants(group: string, participants: GroupParticipant[]) {
    await this.addLidMappings(participants.map((p) => (p.lid && p.phoneNumber ? { lid: p.lid, pn: p.phoneNumber } : undefined)));
    const rows = [
      ...new Map(
        participants
          .map((p) => ({ group_jid: group, participant_jid: this.resolve(p.id, p.phoneNumber), role: p.admin ?? null }))
          .filter((r) => r.participant_jid)
          .map((r) => [r.participant_jid, r]),
      ).values(),
    ];
    await this.sql.begin(async (tx) => {
      // Baileys doesn't serialize event batches: the group fetch at connect and a groups.update can replace
      // the same group at once, and the second insert would hit the rows the first one just wrote.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${'group_participants:' + group}))`;
      await tx`DELETE FROM group_participants WHERE group_jid = ${group}`;
      if (rows.length > 0) await tx`INSERT INTO group_participants ${tx(rows, 'group_jid', 'participant_jid', 'role')}`;
    });
  }

  async onParticipants(ev: { id: string; participants: GroupParticipant[]; action: string }) {
    const group = jidNormalizedUser(ev.id);
    this.groups.delete(group);
    for (const p of ev.participants) {
      const who = this.resolve(p.id, p.phoneNumber);
      if (!who) continue;
      if (ev.action === 'remove') {
        await this.sql`DELETE FROM group_participants WHERE group_jid = ${group} AND participant_jid = ${who}`;
      } else if (['add', 'promote', 'demote'].includes(ev.action)) {
        const role = ev.action === 'promote' ? 'admin' : null;
        await this.sql`
          INSERT INTO group_participants (group_jid, participant_jid, role) VALUES (${group}, ${who}, ${role})
          ON CONFLICT (group_jid, participant_jid) DO UPDATE SET
            role = CASE WHEN ${ev.action} = 'add' THEN group_participants.role ELSE EXCLUDED.role END, updated_at = now()`;
      }
    }
  }

  /** For Baileys' getMessage: lets it re-send or re-decrypt on retry requests. */
  async loadMessage(key: WAMessageKey): Promise<proto.IMessage | undefined> {
    if (!key.id) return undefined;
    const [row] = await this.sql<{ message: unknown }[]>`SELECT raw->'message' AS message FROM messages WHERE msg_id = ${key.id}`;
    return row?.message ? proto.Message.fromObject(fromJson(row.message)) : undefined;
  }
}
