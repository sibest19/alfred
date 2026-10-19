// HTTP API over the archive and the notes, for an agent (n8n, …) that shouldn't hold database credentials.
// Its own service and container, so a restart never touches the WhatsApp session.
// Read-only on the archive; writes only notes. Every request but /health needs "Authorization: Bearer <API_TOKEN>".
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pino } from 'pino';
import { sql } from '@alfred/db';
import { chats, contacts, context, messages, stats } from './archive.js';
import { config } from './config.js';
import { HttpError, readJson, tz, type Query } from './http.js';
import {
  createNote, deleteNote, mergeNotes, pendingConsolidation, putSummary, recordConsolidation, restoreNote, searchNotes, topics, updateNote,
} from './notes.js';
import { transcribe } from './transcribe.js';

const log = pino({ level: config.logLevel });

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
  ['GET', /^\/notes\/topics$/, () => topics()],
  ['PUT', /^\/notes\/summaries$/, async (r) => putSummary(await readJson(r))],
  ['POST', /^\/notes\/merge$/, async (r) => mergeNotes(await readJson(r))],
  ['PATCH', /^\/notes\/(\d+)$/, async (r, _q, id) => updateNote(id, await readJson(r))],
  ['DELETE', /^\/notes\/(\d+)$/, (_r, _q, id) => deleteNote(id)],
  ['POST', /^\/notes\/(\d+)\/restore$/, (_r, _q, id) => restoreNote(id)],
  ['GET', /^\/consolidations\/pending$/, () => pendingConsolidation()],
  ['POST', /^\/consolidations$/, async (r) => recordConsolidation(await readJson(r))],
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
    return send(res, method === 'POST' && (path === '/notes' || path === '/consolidations') ? 201 : 200, await handler(req, url.searchParams, m[1] ?? ''));
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
