// HTTP API over the archive and the notes, for an agent (n8n, …) that shouldn't hold database credentials.
// Its own service and container, so a restart never touches the WhatsApp session.
// Read-only on the archive and on iCloud Mail; writes notes, reminders and iCloud Calendar events. Every request but /health
// and /openrouter/v1/ (the caller's OpenRouter key passes through) needs a configured bearer token and the route's scope.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pino } from 'pino';
import { sql } from '@alfred/db';
import { chats, contacts, context, messages, stats } from './archive.js';
import { createAuthorizer, type Scope } from './auth.js';
import { createEvent, deleteEvent, listEvents, updateEvent } from './calendar.js';
import { config } from './config.js';
import { HttpError, readJson, tz, type Query } from './http.js';
import { openrouter } from './llm.js';
import { readMail, searchMail } from './mail.js';
import {
  createNote, deleteNote, mergeNotes, pendingConsolidation, putSummary, recordConsolidation, restoreNote, searchNotes, topics, updateNote,
} from './notes.js';
import {
  cancelReminder, claimDue, createReminder, doneReminder, listReminders, snoozeReminder, updateReminder,
} from './reminders.js';
import { transcribe } from './transcribe.js';

const log = pino({ level: config.logLevel });
let authorize: ReturnType<typeof createAuthorizer>;
try { authorize = createAuthorizer(config.apiToken, config.apiScopedTokens); }
catch (err) {
  log.fatal(err instanceof Error ? err.message : 'Invalid API authorization configuration');
  process.exit(1);
}

// --- routing ---

type Handler = (req: IncomingMessage, q: Query, id: string) => Promise<unknown>;
const routes: [string, RegExp, Scope, Handler][] = [
  ['GET', /^\/messages$/, 'archive.read', (_r, q) => messages(q)],
  ['GET', /^\/messages\/(\d+)\/context$/, 'archive.read', (_r, q, id) => context(id, q)],
  ['GET', /^\/stats$/, 'archive.read', (_r, q) => stats(q)],
  ['GET', /^\/chats$/, 'archive.read', (_r, q) => chats(q)],
  ['GET', /^\/contacts$/, 'archive.read', (_r, q) => contacts(q)],
  ['GET', /^\/notes$/, 'notes.read', (_r, q) => searchNotes(q)],
  ['POST', /^\/notes$/, 'notes.write', async (r) => createNote(await readJson(r))],
  ['GET', /^\/notes\/topics$/, 'notes.read', () => topics()],
  ['PUT', /^\/notes\/summaries$/, 'notes.consolidate', async (r) => putSummary(await readJson(r))],
  ['POST', /^\/notes\/merge$/, 'notes.consolidate', async (r) => mergeNotes(await readJson(r))],
  ['PATCH', /^\/notes\/(\d+)$/, 'notes.write', async (r, _q, id) => updateNote(id, await readJson(r))],
  ['DELETE', /^\/notes\/(\d+)$/, 'notes.delete', (_r, _q, id) => deleteNote(id)],
  ['POST', /^\/notes\/(\d+)\/restore$/, 'notes.write', (_r, _q, id) => restoreNote(id)],
  ['GET', /^\/consolidations\/pending$/, 'notes.consolidate', () => pendingConsolidation()],
  ['POST', /^\/consolidations$/, 'notes.consolidate', async (r) => recordConsolidation(await readJson(r))],
  ['GET', /^\/reminders$/, 'reminders.read', (_r, q) => listReminders(q)],
  ['POST', /^\/reminders$/, 'reminders.manage', async (r) => createReminder(await readJson(r))],
  ['POST', /^\/reminders\/due$/, 'reminders.claim', () => claimDue()],
  ['PATCH', /^\/reminders\/(\d+)$/, 'reminders.manage', async (r, _q, id) => updateReminder(id, await readJson(r))],
  ['DELETE', /^\/reminders\/(\d+)$/, 'reminders.manage', (_r, _q, id) => cancelReminder(id)],
  ['POST', /^\/reminders\/(\d+)\/snooze$/, 'reminders.manage', async (r, _q, id) => snoozeReminder(id, await readJson(r))],
  ['POST', /^\/reminders\/(\d+)\/done$/, 'reminders.manage', (_r, _q, id) => doneReminder(id)],
  ['POST', /^\/transcribe$/, 'audio.transcribe', (r) => transcribe(r)],
  ['GET', /^\/mail$/, 'mail.read', (_r, q) => searchMail(q)],
  ['GET', /^\/mail\/read$/, 'mail.read', (_r, q) => readMail(q)],
  ['GET', /^\/calendar\/events$/, 'calendar.read', (_r, q) => listEvents(q)],
  ['POST', /^\/calendar\/events$/, 'calendar.create', async (r) => createEvent(await readJson(r))],
  ['PATCH', /^\/calendar\/events\/([0-9a-f]{8})$/, 'calendar.update', async (r, _q, id) => updateEvent(id, await readJson(r))],
  ['DELETE', /^\/calendar\/events\/([0-9a-f]{8})$/, 'calendar.delete', (_r, q, id) => deleteEvent(id, q)],
];

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
  if (url.pathname.startsWith('/openrouter/v1/')) {
    if (authorize(req.headers.authorization)) return send(res, 403, { error: 'use an OpenRouter credential, not an API token' });
    return log.info(await openrouter(req, res, url), 'model call');
  }
  const permissions = authorize(req.headers.authorization);
  if (!permissions) return send(res, 401, { error: 'missing or wrong bearer token' });
  const path = url.pathname.replace(/\/+$/, '') || '/';
  let methodMismatch = false;
  for (const [method, pattern, scope, handler] of routes) {
    const m = pattern.exec(path);
    if (!m) continue;
    if (method !== req.method) {
      methodMismatch = true;
      continue;
    }
    if (!permissions.has(scope)) return send(res, 403, { error: 'token does not permit this operation' });
    return send(res, method === 'POST' && ['/notes', '/consolidations', '/reminders', '/calendar/events'].includes(path) ? 201 : 200, await handler(req, url.searchParams, m[1] ?? ''));
  }
  send(res, methodMismatch ? 405 : 404, { error: methodMismatch ? 'method not allowed' : 'not found' });
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
