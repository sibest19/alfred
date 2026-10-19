// Read-only queries over the WhatsApp archive.
import { sql } from '@alfred/db';
import { and, like, intParam, oneOf, param, timeBound, tsQuery, tz, HttpError, type Fragment, type Query } from './http.js';

const MESSAGE_KINDS = ['text', 'image', 'video', 'audio', 'document', 'sticker', 'other'] as const;

/** Filters shared by /messages and /stats. */
function messageFilters(q: Query): Fragment {
  const chat = param(q, 'chat');
  const sender = param(q, 'sender');
  const kind = oneOf(param(q, 'kind'), MESSAGE_KINDS, 'kind');
  const ts = tsQuery(param(q, 'q'), param(q, 'match') === 'any');
  return and([
    sql`v.type NOT IN ('stub', 'ciphertext', 'protocolMessage', 'reactionMessage')`,
    ts ? sql`v.id IN (SELECT id FROM messages WHERE search @@ to_tsquery('simple', ${ts}))` : undefined,
    chat ? sql`(v.chat_jid = ${chat} OR v.chat_name ILIKE ${like(chat)})` : undefined,
    sender === 'me'
      ? sql`v.from_me`
      : sender
        ? sql`(NOT v.from_me AND (v.sender_jid = ${sender} OR v.sender_name ILIKE ${like(sender)}))`
        : undefined,
    kind ? sql`(${kindExpr}) = ${kind}` : undefined,
    ((t) => (t ? sql`v.sent_at >= ${t}` : undefined))(timeBound(param(q, 'from'), 'from', false)),
    ((t) => (t ? sql`v.sent_at < ${t}` : undefined))(timeBound(param(q, 'to'), 'to', true)),
  ]);
}

const kindExpr = sql`CASE WHEN v.media_kind IS NOT NULL THEN v.media_kind
  WHEN v.type IN ('conversation', 'extendedTextMessage') THEN 'text' ELSE 'other' END`;

const messageColumns = sql`
  v.id::int AS id, to_char(v.sent_at AT TIME ZONE ${tz}, 'YYYY-MM-DD HH24:MI') AS time,
  v.chat_name AS chat, v.chat_jid, v.chat_kind, v.sender_name AS sender, ${kindExpr} AS kind,
  left(v.body, 2000) AS body, v.edited_at IS NOT NULL AS edited, v.deleted_at IS NOT NULL AS deleted,
  v.forwarded, v.quoted_msg_id IS NOT NULL AS reply`;

export async function messages(q: Query) {
  const limit = intParam(q, 'limit', 30, 100);
  const asc = oneOf(param(q, 'order'), ['asc', 'desc'], 'order') === 'asc';
  const rows = await sql`
    SELECT ${messageColumns} FROM messages_view v WHERE ${messageFilters(q)}
    ORDER BY v.sent_at ${asc ? sql`ASC` : sql`DESC`}, v.id LIMIT ${limit}`;
  return { count: rows.length, messages: rows };
}

export async function context(id: string, q: Query) {
  const before = intParam(q, 'before', 10, 50);
  const after = intParam(q, 'after', 10, 50);
  const [target] = await sql`SELECT ${messageColumns}, v.sent_at AS at FROM messages_view v WHERE v.id = ${id}::bigint`;
  if (!target) throw new HttpError(404, `no message ${id}`);
  const { at, ...message } = target;
  const visible = sql`v.chat_jid = ${message.chat_jid} AND v.type NOT IN ('stub', 'ciphertext', 'protocolMessage', 'reactionMessage')`;
  const earlier = await sql`
    SELECT ${messageColumns} FROM messages_view v WHERE ${visible} AND (v.sent_at, v.id) < (${at}, ${id}::bigint)
    ORDER BY v.sent_at DESC, v.id DESC LIMIT ${before}`;
  const later = await sql`
    SELECT ${messageColumns} FROM messages_view v WHERE ${visible} AND (v.sent_at, v.id) > (${at}, ${id}::bigint)
    ORDER BY v.sent_at, v.id LIMIT ${after}`;
  return { chat: message.chat, messages: [...earlier.reverse(), { ...message, target: true }, ...later] };
}

export async function stats(q: Query) {
  const by = oneOf(param(q, 'group_by') ?? 'chat', ['chat', 'sender', 'day', 'month', 'kind'], 'group_by');
  const key = {
    chat: sql`v.chat_name`,
    sender: sql`v.sender_name`,
    day: sql`to_char(v.sent_at AT TIME ZONE ${tz}, 'YYYY-MM-DD')`,
    month: sql`to_char(v.sent_at AT TIME ZONE ${tz}, 'YYYY-MM')`,
    kind: kindExpr,
  }[by!];
  const chronological = by === 'day' || by === 'month';
  const rows = await sql`
    SELECT ${key} AS key, count(*)::int AS messages,
      to_char(min(v.sent_at) AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS first, to_char(max(v.sent_at) AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS last
    FROM messages_view v WHERE ${messageFilters(q)}
    GROUP BY 1 ORDER BY ${chronological ? sql`1` : sql`2 DESC, 1`} LIMIT 100`;
  return { group_by: by, total: rows.reduce((n, r) => n + r.messages, 0), groups: rows };
}

export async function chats(q: Query) {
  const name = param(q, 'q');
  const limit = intParam(q, 'limit', 20, 100);
  const rows = await sql`
    SELECT v.chat_jid AS jid, max(v.chat_name) AS name, max(v.chat_kind) AS kind, count(*)::int AS messages,
      to_char(max(v.sent_at) AT TIME ZONE ${tz}, 'YYYY-MM-DD HH24:MI') AS last_message
    FROM messages_view v
    WHERE ${name ? sql`(v.chat_name ILIKE ${like(name)} OR v.chat_jid LIKE ${like(name)})` : sql`TRUE`}
    GROUP BY v.chat_jid ORDER BY max(v.sent_at) DESC LIMIT ${limit}`;
  return { count: rows.length, chats: rows };
}

export async function contacts(q: Query) {
  const name = param(q, 'q');
  if (!name) throw new HttpError(400, 'q is required');
  const rows = await sql`
    SELECT c.jid, coalesce(c.name, c.notify, c.verified_name) AS name, c.notify AS self_name, c.verified_name AS business_name,
      CASE WHEN coalesce(c.pn, c.jid) LIKE '%@s.whatsapp.net' THEN '+' || split_part(coalesce(c.pn, c.jid), '@', 1) END AS phone
    FROM contacts c
    WHERE c.name ILIKE ${like(name)} OR c.notify ILIKE ${like(name)} OR c.verified_name ILIKE ${like(name)} OR c.jid LIKE ${like(name)}
    ORDER BY c.name NULLS LAST LIMIT 20`;
  return { count: rows.length, contacts: rows };
}

