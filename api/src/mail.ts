// iCloud Mail and Gmail over IMAP, read only: search a mailbox, read messages in full. Mailboxes are opened read only
// (EXAMINE), so reading never marks a message as seen. One connection per request: a few calls an hour don't need
// a pool, and a connection the server dropped while idle can't hang a request.
// Each answer carries `text`, the same as lines for a prompt, so an agent's tool can pass on that alone.
import { ImapFlow, type FetchMessageObject, type MessageAddressObject, type SearchObject } from 'imapflow';
import { simpleParser, type AddressObject } from 'mailparser';
import { dayAfter, wall, weekday, when } from './clock.js';
import { config } from './config.js';
import { HttpError, intParam, param, type Query } from './http.js';

const SNIPPET = 200;
const MAX_BODY = 8000;
const MAX_READ = 10;
// a search line needs the start of the message only; reading one takes all of it, up to this size
const HEAD_BYTES = 16 * 1024;
const MAX_SOURCE = 4 * 1024 * 1024;

const ICLOUD = 'icloud';
type Account = { name: string; gmail: boolean; host: string; user: string; password: string };

function account(name = ICLOUD): Account {
  if (name === ICLOUD) {
    if (!config.icloud.user || !config.icloud.password) throw new HttpError(503, 'iCloud is not configured (ICLOUD_USER, ICLOUD_PASSWORD)');
    return { name, gmail: false, host: 'imap.mail.me.com', ...config.icloud };
  }
  const gmail = Object.hasOwn(config.gmail, name) ? config.gmail[name] : undefined;
  if (!gmail) throw new HttpError(400, `no mail account "${name}"; there are: ${[ICLOUD, ...Object.keys(config.gmail)].join(', ')}`);
  return { name, gmail: true, host: 'imap.gmail.com', ...gmail };
}

// iCloud ids are <mailbox>:<uid> (INBOX:4521). Gmail ids are <account>#<X-GM-MSGID>, the same in every label: with
// no colon, they can't be mistaken for an iCloud id whatever its mailbox is called.
const GMAIL_ID = /^([a-z0-9-]{1,32})#(\d{1,20})$/;
const mailId = (a: Account, mailbox: string, m: FetchMessageObject) => (a.gmail ? `${a.name}#${m.emailId}` : `${mailbox}:${m.uid}`);

/** An id from GET /mail as account and either a Gmail message id or an iCloud mailbox and uid; undefined if it isn't one. */
export function splitMailId(id: string): { name: string; gmailId: string } | { name: string; mailbox: string; uid: number } | undefined {
  const g = GMAIL_ID.exec(id);
  if (g) return { name: g[1], gmailId: g[2] };
  const m = /^(.+):(\d+)$/.exec(id);
  return m ? { name: ICLOUD, mailbox: m[1], uid: Number(m[2]) } : undefined;
}

const label = (a: Account) => (a.gmail ? `Gmail (${a.name})` : 'iCloud');

async function withClient<T>(a: Account, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: a.host, port: 993, secure: true, logger: false,
    auth: { user: a.user, pass: a.password },
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 60_000,
  });
  try {
    await client.connect();
  } catch (err: any) {
    if (err?.authenticationFailed) throw new HttpError(502, `${label(a)} refused the login: check the address and the app password`);
    throw new HttpError(502, `${label(a)} mail is unreachable: ${err?.message ?? err}`);
  }
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

async function inMailbox<T>(client: ImapFlow, mailbox: string, fn: () => Promise<T>): Promise<T> {
  let lock;
  try {
    lock = await client.getMailboxLock(mailbox, { readOnly: true });
  } catch {
    const names = (await client.list()).filter((m) => !m.flags.has('\\Noselect')).map((m) => m.path);
    throw new HttpError(400, `no mailbox "${mailbox}"; there are: ${names.join(', ')}`);
  }
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

// mailbox undefined: Gmail's All Mail (what Gmail's own search covers), iCloud's INBOX
async function withMailbox<T>(a: Account, mailbox: string | undefined, fn: (client: ImapFlow, mailbox: string) => Promise<T>): Promise<T> {
  return withClient(a, async (client) => {
    if (mailbox === undefined && a.gmail) {
      mailbox = (await client.list()).find((m) => m.specialUse === '\\All')?.path;
      if (!mailbox) throw new HttpError(503, `${label(a)} doesn't show All Mail over IMAP: enable "Show in IMAP" for it in Gmail's label settings, or name a mailbox`);
    }
    const box = mailbox ?? 'INBOX';
    return inMailbox(client, box, () => fn(client, box));
  });
}

// Hide My Email relays a sender as news_at_example_com_abc123def456_xyz789@icloud.com: shown as news@example.com
const RELAY = /^(.+?)_at_(.+)_[a-z0-9]+_[a-z0-9]+@(icloud\.com|privaterelay\.appleid\.com)$/i;
const unrelay = (addr: string) => addr.replace(RELAY, (_m, user: string, domain: string) => `${user}@${domain.replace(/_/g, '.')}`);
const address = (list?: MessageAddressObject[]) =>
  (list ?? []).map((a) => (a.name ? `${a.name} <${unrelay(a.address ?? '')}>` : unrelay(a.address ?? ''))).filter(Boolean).join(', ');
const parsedAddress = (v?: AddressObject | AddressObject[]) =>
  (Array.isArray(v) ? v : v ? [v] : []).flatMap((a) => a.value).map((a) => (a.name ? `${a.name} <${unrelay(a.address ?? '')}>` : unrelay(a.address ?? ''))).join(', ');
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const time = (d: Date | string | undefined) => (d ? `${weekday(new Date(d))} ${wall(new Date(d))}` : '');

/** GET /mail: a mailbox's messages, newest first, by words, sender, subject, period or unread. */
export async function searchMail(q: Query) {
  const acct = account(param(q, 'account'));
  const limit = intParam(q, 'limit', 20, 50);
  const from = param(q, 'from') === undefined ? undefined : when(param(q, 'from'), 'from');
  const to = param(q, 'to') === undefined ? undefined : when(param(q, 'to'), 'to');
  const end = to && (to.date ? dayAfter(to.date) : to.at);
  const search: SearchObject = {};
  // Gmail takes its own search syntax (in:inbox, -category:promotions, has:attachment)
  if (param(q, 'q')) search[acct.gmail ? 'gmraw' : 'text'] = param(q, 'q');
  if (param(q, 'sender')) search.from = param(q, 'sender');
  if (param(q, 'subject')) search.subject = param(q, 'subject');
  if (param(q, 'unread') === 'true') search.seen = false;
  // IMAP compares whole days (in the server's zone): a day either side, then the exact times below
  if (from) search.since = new Date(from.at.getTime() - 86_400_000);
  if (end) search.before = new Date(end.getTime() + 86_400_000);
  if (Object.keys(search).length === 0) search.all = true;

  return withMailbox(acct, param(q, 'mailbox'), async (client, mailbox) => {
    const uids = ((await client.search(search, { uid: true })) || []).sort((a, b) => a - b);
    const inPeriod = (m: FetchMessageObject) => {
      const t = m.internalDate ? new Date(m.internalDate).getTime() : 0;
      return (!from || t >= from.at.getTime()) && (!end || t < end.getTime());
    };
    // newest first, a page at a time until one more than the limit (to tell whether there are older ones);
    // the period check drops a few at its edges
    const found: FetchMessageObject[] = [];
    for (let stop = uids.length; stop > 0 && found.length <= limit; stop -= limit + 1) {
      const page = uids.slice(Math.max(0, stop - limit - 1), stop);
      const got = await client.fetchAll(page, { uid: true, emailId: acct.gmail, envelope: true, internalDate: true, flags: true, source: { maxLength: HEAD_BYTES } }, { uid: true });
      found.push(...got.filter(inPeriod).sort((a, b) => b.uid - a.uid));
      if (from && got.some((m) => !inPeriod(m) && new Date(m.internalDate ?? 0) < from.at)) break;
    }
    const mails = await Promise.all(found.slice(0, limit).map(async (m) => {
      let snippet = '';
      try {
        snippet = clip(squash((await simpleParser(m.source ?? Buffer.alloc(0))).text ?? ''), SNIPPET);
      } catch {}
      return {
        id: mailId(acct, mailbox, m), date: time(m.internalDate), from: address(m.envelope?.from), to: address(m.envelope?.to),
        subject: m.envelope?.subject ?? '', unread: !m.flags?.has('\\Seen'), snippet,
      };
    }));
    const lines = mails.map((m) => `[${m.id}] ${m.date} | ${m.from} | ${m.subject}${m.unread ? ' (unread)' : ''}: ${m.snippet}`);
    if (!mails.length) lines.push(`No mail in ${acct.name} ${mailbox} for this search.`);
    else if (found.length > limit) lines.push('(older matches not shown: narrow the search, or move "to" back)');
    return { account: acct.name, mailbox, mails, text: lines.join('\n') };
  });
}

/** GET /mail/read?ids=INBOX:4521,personal#1781234567890123456: messages in full (text, recipients, attachment names). */
export async function readMail(q: Query) {
  const ids = (param(q, 'ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) throw new HttpError(400, 'ids: one or more ids from GET /mail, like INBOX:4521');
  if (ids.length > MAX_READ) throw new HttpError(400, `ids: at most ${MAX_READ} at a time`);
  // per account and mailbox (Gmail: All Mail), the iCloud uids or Gmail message ids to read there
  const groups = new Map<string, { name: string; mailbox?: string; uids: number[]; gmailIds: string[] }>();
  for (const id of ids) {
    const m = splitMailId(id);
    if (!m) throw new HttpError(400, `"${id}" is not a mail id; use an id from GET /mail, like INBOX:4521`);
    const mailbox = 'mailbox' in m ? m.mailbox : undefined;
    const key = `${m.name}\n${mailbox ?? ''}`;
    const g = groups.get(key) ?? { name: m.name, mailbox, uids: [], gmailIds: [] };
    if ('uid' in m) g.uids.push(m.uid);
    else g.gmailIds.push(m.gmailId);
    groups.set(key, g);
  }
  const mails: Record<string, unknown>[] = [];
  const fetchInto = async (client: ImapFlow, acct: Account, mailbox: string, uids: number[]) => {
    const got = await client.fetchAll(uids, { uid: true, emailId: acct.gmail, internalDate: true, flags: true, source: { maxLength: MAX_SOURCE } }, { uid: true });
    for (const m of got) {
      const p = await simpleParser(m.source ?? Buffer.alloc(0));
      mails.push({
        id: mailId(acct, mailbox, m), date: time(p.date ?? m.internalDate), from: parsedAddress(p.from), to: parsedAddress(p.to),
        cc: parsedAddress(p.cc), subject: p.subject ?? '', unread: !m.flags?.has('\\Seen'),
        body: clip((p.text ?? '').replace(/\n{3,}/g, '\n\n').trim(), MAX_BODY),
        attachments: p.attachments.filter((a) => a.contentDisposition !== 'inline').map((a) => a.filename ?? a.contentType),
      });
    }
    return got.map((m) => m.emailId);
  };
  for (const g of groups.values()) {
    const acct = account(g.name);
    if (!acct.gmail) {
      await withMailbox(acct, g.mailbox, (client, mailbox) => fetchInto(client, acct, mailbox, g.uids));
      continue;
    }
    await withClient(acct, async (client) => {
      // All Mail first, then Spam and Trash, which it leaves out; without All Mail shown over IMAP, every mailbox
      const boxes = (await client.list()).filter((m) => !m.flags.has('\\Noselect'));
      const all = boxes.find((m) => m.specialUse === '\\All');
      const order = all ? [all, ...boxes.filter((m) => m.specialUse === '\\Junk' || m.specialUse === '\\Trash')] : boxes;
      let left = g.gmailIds;
      for (const box of order) {
        if (!left.length) break;
        await inMailbox(client, box.path, async () => {
          const uids: number[] = [];
          for (const emailId of left) uids.push(...((await client.search({ emailId }, { uid: true })) || []));
          if (!uids.length) return;
          const found = await fetchInto(client, acct, box.path, uids);
          left = left.filter((id) => !found.includes(id));
        });
      }
    });
  }
  const missing = ids.filter((id) => !mails.some((m) => m.id === id));
  const text = [
    ...mails.map((m: any) => [
      `[${m.id}] ${m.date}`, `From: ${m.from}`, `To: ${m.to}`, ...(m.cc ? [`Cc: ${m.cc}`] : []), `Subject: ${m.subject}`,
      ...(m.attachments.length ? [`Attachments: ${m.attachments.join(', ')}`] : []), '', m.body,
    ].join('\n')),
    ...(missing.length ? [`Not found (deleted or moved?): ${missing.join(', ')}`] : []),
  ].join('\n\n---\n\n');
  return { mails, missing, text };
}
