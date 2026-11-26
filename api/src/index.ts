// HTTP API over the archive, mail, calendars and to-dos, for an agent that shouldn't hold database credentials.
// Its own service and container, so a restart never touches the WhatsApp session.
// Read-only on the archive and on the mail; writes calendar events (iCloud, Radicale) and to-dos (Radicale). Every request but /health
// needs a configured bearer token and the route's scope.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pino } from 'pino';
import { sql } from '@alfred/db';
import { chats, contacts, context, messages, stats } from './archive.js';
import { createAuthorizer, type Scope } from './auth.js';
import { createEvent, deleteEvent, listEvents, updateEvent } from './calendar.js';
import { config } from './config.js';
import { HttpError, readJson, tz, type Query } from './http.js';
import { readMail, searchMail } from './mail.js';
import { createTodo, deleteTodo, doneTodo, listTodos, updateTodo } from './todos.js';

const log = pino({ level: config.logLevel });
let authorize: ReturnType<typeof createAuthorizer>;
try { authorize = createAuthorizer(config.apiScopedTokens); }
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
  ['GET', /^\/mail$/, 'mail.read', (_r, q) => searchMail(q)],
  ['GET', /^\/mail\/read$/, 'mail.read', (_r, q) => readMail(q)],
  ['GET', /^\/calendar\/events$/, 'calendar.read', (_r, q) => listEvents(q)],
  ['POST', /^\/calendar\/events$/, 'calendar.create', async (r) => createEvent(await readJson(r))],
  ['PATCH', /^\/calendar\/events\/([0-9a-f]{8})$/, 'calendar.update', async (r, _q, id) => updateEvent(id, await readJson(r))],
  ['DELETE', /^\/calendar\/events\/([0-9a-f]{8})$/, 'calendar.delete', (_r, q, id) => deleteEvent(id, q)],
  ['GET', /^\/todos$/, 'todos.read', (_r, q) => listTodos(q)],
  ['POST', /^\/todos$/, 'todos.manage', async (r) => createTodo(await readJson(r))],
  ['PATCH', /^\/todos\/([0-9a-f]{8})$/, 'todos.manage', async (r, _q, id) => updateTodo(id, await readJson(r))],
  ['POST', /^\/todos\/([0-9a-f]{8})\/done$/, 'todos.manage', (_r, _q, id) => doneTodo(id)],
  ['DELETE', /^\/todos\/([0-9a-f]{8})$/, 'todos.manage', (_r, _q, id) => deleteTodo(id)],
];

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

// Which credential made each request, by name, for the request log: an audit trail of the API's writes
const callers = new WeakMap<IncomingMessage, string>();

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://api');
  if (url.pathname === '/health') {
    await sql`SELECT 1`;
    return send(res, 200, { ok: true });
  }
  const caller = authorize(req.headers.authorization);
  if (!caller) return send(res, 401, { error: 'missing or wrong bearer token' });
  callers.set(req, caller.name);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  let methodMismatch = false;
  for (const [method, pattern, scope, handler] of routes) {
    const m = pattern.exec(path);
    if (!m) continue;
    if (method !== req.method) {
      methodMismatch = true;
      continue;
    }
    if (!caller.scopes.has(scope)) return send(res, 403, { error: 'token does not permit this operation' });
    return send(res, method === 'POST' && ['/calendar/events', '/todos'].includes(path) ? 201 : 200, await handler(req, url.searchParams, m[1] ?? ''));
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
        log.info({ method: req.method, path: req.url?.split('?')[0], caller: callers.get(req), status: res.statusCode, ms: Date.now() - started }, 'request');
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
