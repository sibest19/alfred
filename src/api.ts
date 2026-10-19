// HTTP API over the archive and the notes, for an agent (n8n, …) that shouldn't hold database credentials.
// Its own process (node dist/api.js) and container, so a restart never touches the WhatsApp session.
// Read-only on the archive; writes only notes. Every request but /health needs "Authorization: Bearer <API_TOKEN>".
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { PendingQuery, Row } from 'postgres';
import { pino } from 'pino';
import { config } from './config.js';
import { sql } from './db.js';

const log = pino({ level: config.logLevel });
const tz = config.timezone;
const MAX_JSON = 1024 * 1024;
const MAX_AUDIO = 25 * 1024 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Query = URLSearchParams;
type Fragment = PendingQuery<Row[]>;

// --- request helpers ---

/** A query parameter; empty means absent (tools tend to send every parameter, filled or not). */
const param = (q: Query, name: string) => q.get(name)?.trim() || undefined;

function intParam(q: Query, name: string, fallback: number, max: number): number {
  const raw = param(q, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `${name} must be a non-negative integer`);
  return Math.min(n, max);
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], name: string): T | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) throw new HttpError(400, `${name} must be one of: ${allowed.join(', ')}`);
  return value as T;
}

const DATE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** A date or date-time; without an offset it's in the API's time zone. A bare date as `to` includes that day. */
function timeBound(value: string | undefined, name: string, end: boolean): Fragment | undefined {
  if (value === undefined) return undefined;
  if (!DATE.test(value)) throw new HttpError(400, `${name} must look like 2026-10-01 or 2026-10-01 18:30`);
  const local = !/(Z|[+-]\d{2}:?\d{2})$/.test(value);
  const t = local ? sql`(${value}::timestamp AT TIME ZONE ${tz})` : sql`${value}::timestamptz`;
  return end && value.length === 10 ? sql`${t} + interval '1 day'` : t;
}

/** Words to a prefix tsquery ("cena sabato" → cena:* & sabato:*), or undefined when there are none. */
function tsQuery(text: string | undefined, any: boolean): string | undefined {
  const words = text?.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return words?.length ? words.map((w) => `${w}:*`).join(any ? ' | ' : ' & ') : undefined;
}

const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const and = (parts: (Fragment | undefined)[]): Fragment =>
  parts.filter((p): p is Fragment => p !== undefined).reduce((acc, p) => sql`${acc} AND ${p}`, sql`TRUE`);

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, `body larger than ${limit} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(req, MAX_JSON);
  if (body.length === 0) return {};
  try {
    const value = JSON.parse(body.toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {}
  throw new HttpError(400, 'body must be a JSON object');
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());

/** Tags as a JSON array or a comma-separated string; lowercase, unique. */
function tags(v: unknown): string[] {
  const list = Array.isArray(v) ? v.map(text) : text(v).split(',');
  return [...new Set(list.map((t) => t.trim().toLowerCase()).filter(Boolean))];
}

// --- archive ---

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

async function messages(q: Query) {
  const limit = intParam(q, 'limit', 30, 100);
  const asc = oneOf(param(q, 'order'), ['asc', 'desc'], 'order') === 'asc';
  const rows = await sql`
    SELECT ${messageColumns} FROM messages_view v WHERE ${messageFilters(q)}
    ORDER BY v.sent_at ${asc ? sql`ASC` : sql`DESC`}, v.id LIMIT ${limit}`;
  return { count: rows.length, messages: rows };
}

async function context(id: string, q: Query) {
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

async function stats(q: Query) {
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

async function chats(q: Query) {
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

async function contacts(q: Query) {
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

// --- notes ---

const NOTE_KINDS = ['note', 'fact', 'preference', 'idea', 'link', 'todo'] as const;
const NOTE_SOURCES = ['user', 'assistant'] as const;

const noteColumns = sql`
  id::int AS id, kind, title, content, tags, source,
  to_char(created_at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS created, to_char(updated_at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS updated`;

async function searchNotes(q: Query) {
  const words = param(q, 'q');
  const ts = tsQuery(words, true);
  const tag = param(q, 'tag')?.toLowerCase();
  const kind = oneOf(param(q, 'kind'), NOTE_KINDS, 'kind');
  const limit = intParam(q, 'limit', 20, 100);
  const match = ts
    ? sql`(search @@ to_tsquery('simple', ${ts}) OR title ILIKE ${like(words!)} OR content ILIKE ${like(words!)}
           OR EXISTS (SELECT 1 FROM unnest(tags) t WHERE t ILIKE ${like(words!)}))`
    : undefined;
  const rows = await sql`
    SELECT ${noteColumns} FROM notes
    WHERE ${and([sql`deleted_at IS NULL`, match, tag ? sql`${tag} = ANY (tags)` : undefined, kind ? sql`kind = ${kind}` : undefined])}
    ORDER BY ${ts ? sql`ts_rank(search, to_tsquery('simple', ${ts})) DESC,` : sql``} updated_at DESC LIMIT ${limit}`;
  return { count: rows.length, notes: rows };
}

async function createNote(body: Record<string, unknown>) {
  const title = text(body.title);
  const content = text(body.content);
  if (!title || !content) throw new HttpError(400, 'title and content are required');
  const kind = oneOf(text(body.kind) || 'note', NOTE_KINDS, 'kind');
  const source = oneOf(text(body.source) || 'assistant', NOTE_SOURCES, 'source');
  const [note] = await sql`
    INSERT INTO notes (kind, title, content, tags, source) VALUES (${kind!}, ${title}, ${content}, ${tags(body.tags)}, ${source!})
    RETURNING ${noteColumns}`;
  return note;
}

async function updateNote(id: string, body: Record<string, unknown>) {
  const title = text(body.title) || null;
  const content = text(body.content) || null;
  const kind = oneOf(text(body.kind) || undefined, NOTE_KINDS, 'kind') ?? null;
  // absent or empty keeps the tags; to clear them, send []
  const newTags = body.tags === undefined || text(body.tags) === '' ? null : tags(body.tags);
  const [note] = await sql`
    UPDATE notes SET title = coalesce(${title}, title), content = coalesce(${content}, content), kind = coalesce(${kind}, kind),
      tags = coalesce(${newTags}::text[], tags), updated_at = now()
    WHERE id = ${id}::bigint AND deleted_at IS NULL RETURNING ${noteColumns}`;
  if (!note) throw new HttpError(404, `no note ${id}`);
  return note;
}

async function deleteNote(id: string) {
  const [note] = await sql`UPDATE notes SET deleted_at = now() WHERE id = ${id}::bigint AND deleted_at IS NULL RETURNING id::int AS id, title`;
  if (!note) throw new HttpError(404, `no note ${id}`);
  return { deleted: note };
}

// --- speech-to-text: passed through to the transcriber, so consumers need only this service ---

async function transcribe(req: IncomingMessage) {
  if (!config.transcriberUrl) throw new HttpError(503, 'no transcriber configured');
  const audio = await readBody(req, MAX_AUDIO);
  if (audio.length === 0) throw new HttpError(400, 'empty body: send the audio file as the request body');
  const res = await fetch(`${config.transcriberUrl}/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': req.headers['content-type'] ?? 'application/octet-stream' },
    body: audio as Uint8Array<ArrayBuffer>,
    signal: AbortSignal.timeout(300_000),
  }).catch((err) => {
    throw new HttpError(502, `transcriber unreachable: ${err?.cause?.code ?? err?.message ?? err}`);
  });
  const body = await res.text();
  if (!res.ok) throw new HttpError(res.status === 400 ? 400 : 502, `transcriber: HTTP ${res.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

// --- routing ---

type Handler = (req: IncomingMessage, q: Query, id: string) => Promise<unknown>;
const routes: [string, RegExp, Handler][] = [
  ['GET', /^\/messages$/, (_r, q) => messages(q)],
  ['GET', /^\/messages\/(\d+)\/context$/, (_r, q, id) => context(id, q)],
  ['GET', /^\/stats$/, (_r, q) => stats(q)],
  ['GET', /^\/chats$/, (_r, q) => chats(q)],
  ['GET', /^\/contacts$/, (_r, q) => contacts(q)],
  ['GET', /^\/notes$/, (_r, q) => searchNotes(q)],
  ['POST', /^\/notes$/, async (r) => createNote(await readJson(r))],
  ['PATCH', /^\/notes\/(\d+)$/, async (r, _q, id) => updateNote(id, await readJson(r))],
  ['DELETE', /^\/notes\/(\d+)$/, (_r, _q, id) => deleteNote(id)],
  ['POST', /^\/transcribe$/, (r) => transcribe(r)],
];

const token = Buffer.from(config.apiToken);
function authorized(req: IncomingMessage): boolean {
  const given = Buffer.from(req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '');
  return given.length === token.length && timingSafeEqual(given, token);
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://api');
  if (url.pathname === '/health') {
    await sql`SELECT 1`;
    return send(res, 200, { ok: true });
  }
  if (!authorized(req)) return send(res, 401, { error: 'missing or wrong bearer token' });
  const path = url.pathname.replace(/\/+$/, '') || '/';
  let methodMismatch = false;
  for (const [method, pattern, handler] of routes) {
    const m = pattern.exec(path);
    if (!m) continue;
    if (method !== req.method) {
      methodMismatch = true;
      continue;
    }
    return send(res, method === 'POST' && path === '/notes' ? 201 : 200, await handler(req, url.searchParams, m[1] ?? ''));
  }
  send(res, methodMismatch ? 405 : 404, { error: methodMismatch ? 'method not allowed' : 'not found' });
}

if (token.length < 16) {
  log.fatal('API_TOKEN must be set (16 characters or more)');
  process.exit(1);
}

const server = createServer((req, res) => {
  const started = Date.now();
  handle(req, res)
    .catch((err) => {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      log.error({ err, method: req.method, url: req.url?.split('?')[0] }, 'request failed');
      send(res, 500, { error: 'internal error' });
    })
    .finally(() => {
      if (req.url !== '/health') {
        log.info({ method: req.method, path: req.url?.split('?')[0], status: res.statusCode, ms: Date.now() - started }, 'request');
      }
    });
});
server.listen(config.httpPort, () => log.info({ port: config.httpPort, timezone: tz }, 'api listening'));

const shutdown = () => {
  server.close();
  void sql.end({ timeout: 5 }).then(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
