// iCloud Mail over IMAP, read only: search a mailbox, read messages in full. Mailboxes are opened read only
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

const configured = () => Boolean(config.icloud.user && config.icloud.password);

async function withMailbox<T>(mailbox: string, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  if (!configured()) throw new HttpError(503, 'iCloud is not configured (ICLOUD_USER, ICLOUD_PASSWORD)');
  const client = new ImapFlow({
    host: 'imap.mail.me.com', port: 993, secure: true, logger: false,
    auth: { user: config.icloud.user, pass: config.icloud.password },
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 60_000,
  });
  try {
    await client.connect();
  } catch (err: any) {
    if (err?.authenticationFailed) throw new HttpError(502, 'iCloud refused the login: check ICLOUD_USER and the app-specific password');
    throw new HttpError(502, `iCloud Mail is unreachable: ${err?.message ?? err}`);
  }
  try {
    let lock;
    try {
      lock = await client.getMailboxLock(mailbox, { readOnly: true });
    } catch {
      const names = (await client.list()).filter((m) => !m.flags.has('\\Noselect')).map((m) => m.path);
      throw new HttpError(400, `no mailbox "${mailbox}"; there are: ${names.join(', ')}`);
    }
    try {
      return await fn(client);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => client.close());
  }
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
  const mailbox = param(q, 'mailbox') ?? 'INBOX';
  const limit = intParam(q, 'limit', 20, 50);
  const from = param(q, 'from') === undefined ? undefined : when(param(q, 'from'), 'from');
  const to = param(q, 'to') === undefined ? undefined : when(param(q, 'to'), 'to');
  const end = to && (to.date ? dayAfter(to.date) : to.at);
  const search: SearchObject = {};
  if (param(q, 'q')) search.text = param(q, 'q');
  if (param(q, 'sender')) search.from = param(q, 'sender');
  if (param(q, 'subject')) search.subject = param(q, 'subject');
  if (param(q, 'unread') === 'true') search.seen = false;
  // IMAP compares whole days (in the server's zone): a day either side, then the exact times below
  if (from) search.since = new Date(from.at.getTime() - 86_400_000);
  if (end) search.before = new Date(end.getTime() + 86_400_000);
  if (Object.keys(search).length === 0) search.all = true;

  return withMailbox(mailbox, async (client) => {
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
      const got = await client.fetchAll(page, { uid: true, envelope: true, internalDate: true, flags: true, source: { maxLength: HEAD_BYTES } }, { uid: true });
      found.push(...got.filter(inPeriod).sort((a, b) => b.uid - a.uid));
      if (from && got.some((m) => !inPeriod(m) && new Date(m.internalDate ?? 0) < from.at)) break;
    }
    const mails = await Promise.all(found.slice(0, limit).map(async (m) => {
      let snippet = '';
      try {
        snippet = clip(squash((await simpleParser(m.source ?? Buffer.alloc(0))).text ?? ''), SNIPPET);
      } catch {}
      return {
        id: `${mailbox}:${m.uid}`, date: time(m.internalDate), from: address(m.envelope?.from), to: address(m.envelope?.to),
        subject: m.envelope?.subject ?? '', unread: !m.flags?.has('\\Seen'), snippet,
      };
    }));
    const lines = mails.map((m) => `[${m.id}] ${m.date} | ${m.from} | ${m.subject}${m.unread ? ' (unread)' : ''}: ${m.snippet}`);
    if (!mails.length) lines.push(`No mail in ${mailbox} for this search.`);
    else if (found.length > limit) lines.push('(older matches not shown: narrow the search, or move "to" back)');
    return { mailbox, mails, text: lines.join('\n') };
  });
}

/** GET /mail/read?ids=INBOX:4521,INBOX:4522: messages in full (text, recipients, attachment names). */
export async function readMail(q: Query) {
  const ids = (param(q, 'ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) throw new HttpError(400, 'ids: one or more ids from GET /mail, like INBOX:4521');
  if (ids.length > MAX_READ) throw new HttpError(400, `ids: at most ${MAX_READ} at a time`);
  const byMailbox = new Map<string, number[]>();
  for (const id of ids) {
    const m = /^(.+):(\d+)$/.exec(id);
    if (!m) throw new HttpError(400, `"${id}" is not a mail id; ids look like INBOX:4521`);
    byMailbox.set(m[1], [...(byMailbox.get(m[1]) ?? []), Number(m[2])]);
  }
  const mails: Record<string, unknown>[] = [];
  for (const [mailbox, uids] of byMailbox) {
    await withMailbox(mailbox, async (client) => {
      const got = await client.fetchAll(uids, { uid: true, internalDate: true, flags: true, source: { maxLength: MAX_SOURCE } }, { uid: true });
      for (const m of got) {
        const p = await simpleParser(m.source ?? Buffer.alloc(0));
        mails.push({
          id: `${mailbox}:${m.uid}`, date: time(p.date ?? m.internalDate), from: parsedAddress(p.from), to: parsedAddress(p.to),
          cc: parsedAddress(p.cc), subject: p.subject ?? '', unread: !m.flags?.has('\\Seen'),
          body: clip((p.text ?? '').replace(/\n{3,}/g, '\n\n').trim(), MAX_BODY),
          attachments: p.attachments.filter((a) => a.contentDisposition !== 'inline').map((a) => a.filename ?? a.contentType),
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
