import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { loadConfig } from './config.js';
import { createService } from './server.js';

const apiToken = 'scoped-api-test-0123456789'; // gitleaks:allow -- synthetic test credential
const mcpToken = 'mcp-client-test-0123456789';
const calls: { path: string; method?: string; token?: string; body?: string }[] = [];
let mode = 'ok';
let mcp: Server;
let url: string;
const upstream = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  calls.push({ path: req.url!, method: req.method, token: req.headers.authorization, body });
  if (mode === 'redirect') { res.writeHead(302, { Location: url + '/trap' }).end(); return; }
  if (['400', '401', '404', '429', '503'].includes(mode)) { res.writeHead(Number(mode)).end(apiToken); return; }
  if (mode === 'failure') { res.writeHead(403).end(apiToken); return; }
  if (mode === 'invalid') { res.end('invalid JSON ' + apiToken); return; }
  if (mode === 'large') { res.end(JSON.stringify({ body: 'x'.repeat(300_000) })); return; }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ path: req.url }));
});

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return 'http://127.0.0.1:' + address.port;
}
async function close(server: Server) { await new Promise<void>((resolve) => server.close(() => resolve())); }
function post(body: unknown, headers: Record<string, string> = {}) {
  return fetch(url + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18', Authorization: 'Bearer ' + mcpToken, ...headers },
    body: JSON.stringify(body),
  });
}
async function rpc(method: string, params: unknown = {}) {
  const response = await post({ jsonrpc: '2.0', id: 1, method, params });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.text();
  const json = response.headers.get('content-type')?.includes('text/event-stream')
    ? body.split('\n').find((line) => line.startsWith('data:'))?.slice(5) : body;
  assert.ok(json, body);
  return JSON.parse(json) as {
    result: { protocolVersion: string; isError?: boolean; tools: {
      name: string; annotations: { readOnlyHint: boolean }; inputSchema: { additionalProperties: boolean };
    }[] };
    error?: unknown;
  };
}
const call = (name: string, args: Record<string, unknown> = {}) => rpc('tools/call', { name, arguments: args });

before(async () => {
  const apiUrl = await listen(upstream);
  // the suite makes more calls than the default limit allows per minute
  mcp = createService(loadConfig({ ALFRED_API_URL: apiUrl, ALFRED_API_TOKEN: apiToken, MCP_TOKEN: mcpToken, MCP_RATE_LIMIT: '200' }));
  url = await listen(mcp);
});
after(async () => { await close(mcp); await close(upstream); });
beforeEach(() => { calls.length = 0; mode = 'ok'; });

test('configuration rejects unsafe origins, shared credentials and invalid ports', () => {
  const env = { ALFRED_API_TOKEN: apiToken, MCP_TOKEN: mcpToken };
  for (const origin of ['file:///tmp/archive', 'http://user:secret@api', 'http://api/notes', 'http://api?path=/notes', 'http://api#secret']) {
    assert.throws(() => loadConfig({ ...env, ALFRED_API_URL: origin }));
  }
  assert.throws(() => loadConfig({ ...env, MCP_TOKEN: apiToken }));
  assert.throws(() => loadConfig({ ...env, MCP_TOKEN: 'short' }));
  assert.throws(() => loadConfig({ ...env, HTTP_PORT: '8080bad' }));
  assert.throws(() => loadConfig({ ...env, MCP_ALLOWED_HOSTS: '*' }));
  for (const value of ['0', '-1', '1.5', 'NaN', '1001']) {
    assert.throws(() => loadConfig({ ...env, MCP_RATE_LIMIT: value }));
    assert.throws(() => loadConfig({ ...env, MCP_MAX_CONCURRENT: value }));
  }
});

const READ_TOOLS = [
  'calendar_events', 'mail_read', 'mail_search', 'reminders_list',
  'whatsapp_context', 'whatsapp_find_chat', 'whatsapp_find_contact', 'whatsapp_search', 'whatsapp_stats',
];
const WRITE_TOOLS = ['event_create', 'event_delete', 'event_update', 'reminder_complete', 'reminder_create', 'reminder_delete', 'reminder_update'];

test('MCP initializes and advertises its read-only and write tools', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  const result = await rpc('tools/list');
  assert.deepEqual(result.result.tools.map((t: { name: string }) => t.name).sort(), [...READ_TOOLS, ...WRITE_TOOLS].sort());
  for (const tool of result.result.tools) {
    assert.equal(tool.annotations.readOnlyHint, READ_TOOLS.includes(tool.name), tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  assert.equal(calls.length, 0);
});

test('the read tools use fixed GET paths and only the upstream credential', async () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ['whatsapp_search', { q: 'cena & sabato', sender: 'me', limit: 5 }, '/messages'],
    ['whatsapp_context', { id: 42, before: 2, after: 3 }, '/messages/42/context'],
    ['whatsapp_stats', { group_by: 'day' }, '/stats'],
    ['whatsapp_find_chat', { q: 'Weekend' }, '/chats'],
    ['whatsapp_find_contact', { q: 'Rossi' }, '/contacts'],
    ['mail_search', { account: 'personal', q: 'fattura', unread: true, limit: 5 }, '/mail'],
    ['mail_read', { ids: ['INBOX:4521', 'personal#1781234567890123456'] }, '/mail/read'],
    ['calendar_events', { from: '2026-11-12', to: '2026-11-19' }, '/calendar/events'],
    ['reminders_list', { q: 'dentist', done: true }, '/todos'],
  ];
  for (const [name, args, path] of cases) {
    const answer = await call(name, args);
    assert.ok(!answer.error && !answer.result.isError);
    assert.equal(new URL(calls.at(-1)!.path, 'http://api').pathname, path);
    assert.equal(calls.at(-1)!.method, 'GET');
    assert.equal(calls.at(-1)!.token, 'Bearer ' + apiToken);
    assert.ok(!JSON.stringify(answer).includes(apiToken));
  }
  const search = new URL(calls[0].path, 'http://api');
  assert.equal(search.searchParams.get('q'), 'cena & sabato');
  assert.equal(search.searchParams.get('sender'), 'me');
  assert.equal(new URL(calls[5].path, 'http://api').searchParams.get('unread'), 'true');
  assert.equal(new URL(calls[5].path, 'http://api').searchParams.get('account'), 'personal');
  assert.equal(new URL(calls[6].path, 'http://api').searchParams.get('ids'), 'INBOX:4521,personal#1781234567890123456');
  assert.equal(new URL(calls[8].path, 'http://api').searchParams.get('done'), 'true');
  assert.equal(calls.length, 9);
});

test('the write tools call fixed paths with their method and a JSON body', async () => {
  const cases: [string, Record<string, unknown>, string, string, Record<string, unknown> | undefined][] = [
    ['event_create', { title: 'Dinner', start: '2026-11-13 20:00', all_day: false, calendar: 'Family' }, 'POST', '/calendar/events',
      { title: 'Dinner', start: '2026-11-13 20:00', all_day: 'false', calendar: 'Family' }],
    ['event_update', { id: '3fa2b9c1', start: '2026-11-14 20:00', occurrence: '2026-11-13', series: true }, 'PATCH', '/calendar/events/3fa2b9c1',
      { start: '2026-11-14 20:00', occurrence: '2026-11-13', series: 'true' }],
    ['event_delete', { id: '3fa2b9c1', occurrence: '2026-11-13' }, 'DELETE', '/calendar/events/3fa2b9c1', undefined],
    ['reminder_create', { title: 'Call the plumber', due: '2026-11-13 15:00', repeat: 'FREQ=WEEKLY;BYDAY=MO' }, 'POST', '/todos',
      { title: 'Call the plumber', due: '2026-11-13 15:00', repeat: 'FREQ=WEEKLY;BYDAY=MO' }],
    ['reminder_update', { id: '0a1b2c3d', due: '-' }, 'PATCH', '/todos/0a1b2c3d', { due: '-' }],
    ['reminder_complete', { id: '0a1b2c3d' }, 'POST', '/todos/0a1b2c3d/done', undefined],
    ['reminder_delete', { id: '0a1b2c3d' }, 'DELETE', '/todos/0a1b2c3d', undefined],
  ];
  for (const [name, args, method, path, body] of cases) {
    const answer = await call(name, args);
    assert.ok(!answer.error && !answer.result.isError, name);
    const sent = calls.at(-1)!;
    assert.equal(sent.method, method, name);
    assert.equal(new URL(sent.path, 'http://api').pathname, path, name);
    assert.equal(sent.token, 'Bearer ' + apiToken);
    assert.deepEqual(sent.body ? JSON.parse(sent.body) : undefined, body, name);
  }
  assert.equal(new URL(calls[2].path, 'http://api').searchParams.get('occurrence'), '2026-11-13');
});

test('unknown tools, injected URLs, invalid IDs and excessive limits never reach the API', async () => {
  for (const [name, args] of [
    ['delete_event', {}], ['whatsapp_search', { url: 'http://evil.test' }],
    ['whatsapp_context', { id: '../../notes' }], ['whatsapp_search', { limit: 101 }],
    ['whatsapp_context', { id: 1, before: 51 }], ['whatsapp_find_contact', { q: '   ' }],
    ['mail_read', { ids: [] }], ['mail_read', { ids: ['INBOX:1,INBOX:2'] }], ['mail_read', { ids: ['../x'] }], ['mail_read', { ids: ['INBOX\n:1'] }],
    ['mail_search', { limit: 51 }], ['mail_search', { account: '../x' }], ['mail_read', { ids: ['Personal#1'] }], ['mail_read', { ids: ['personal#1,2'] }], ['calendar_events', { calendar: 'x', url: 'http://evil.test' }],
    ['event_delete', { id: '../todos' }], ['event_update', { id: '3FA2B9C1' }], ['reminder_complete', { id: '0a1b2c3' }],
    ['reminder_delete', {}], ['reminder_create', { due: '2026-11-13' }], ['reminder_create', { title: 'x', repeat: 'FREQ=DAILY\nX' }],
    ['event_create', { title: 'x' }],
  ] as [string, Record<string, unknown>][]) {
    const answer = await call(name, args);
    assert.ok(answer.error || answer.result?.isError, name);
  }
  assert.equal(calls.length, 0);
});

test('authentication, Host and Origin guards apply before dispatch', async () => {
  for (const credential of ['', 'Bearer wrong', 'Bearer ' + apiToken]) {
    const response = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { Authorization: credential });
    assert.equal(response.status, 401);
  }
  for (const headers of [{ Origin: 'https://evil.test' }, { Origin: 'null' }]) {
    const response = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers);
    assert.equal(response.status, 403);
  }
  // Node fetch normalizes Host; send the hostile header on the wire.
  await new Promise<void>((resolve, reject) => {
    request(url + '/mcp', { method: 'POST', headers: { Host: 'evil.test' } }, (res) => {
      res.resume();
      try { assert.equal(res.statusCode, 403); resolve(); } catch (err) { reject(err); }
    }).on('error', reject).end();
  });
  assert.equal((await fetch(url + '/health')).status, 200);
  assert.equal((await fetch(url + '/mcp', { headers: { Authorization: 'Bearer ' + mcpToken } })).status, 405);
  assert.equal(calls.length, 0);
});

test('oversized requests are rejected before dispatch', async () => {
  const response = await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { text: 'x'.repeat(20_000) } });
  assert.equal(response.status, 413);
  assert.equal(calls.length, 0);
});

test('upstream failures, redirects and invalid/large replies are errors, without secrets or retries', async () => {
  for (const failure of ['failure', 'redirect', 'invalid', 'large']) {
    mode = failure;
    calls.length = 0;
    const answer = await call('whatsapp_search');
    assert.equal(answer.result.isError, true, failure);
    assert.ok(!JSON.stringify(answer).includes(apiToken));
    assert.equal(calls.length, 1);
  }
});

test('2026 protocol discovery, headers, errors and stateless transport remain enforced', async () => {
  const version = '2026-07-28';
  const modern = (method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) => post({
    jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: {
      'io.modelcontextprotocol/protocolVersion': headers['MCP-Protocol-Version'] ?? version,
      'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
      'io.modelcontextprotocol/clientCapabilities': {},
    } },
  }, { 'MCP-Protocol-Version': version, 'Mcp-Method': method,
    ...(typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {}), ...headers });
  const discovery = await modern('server/discover');
  assert.equal(discovery.status, 200);
  assert.equal(discovery.headers.get('mcp-session-id'), null);
  assert.match(await discovery.text(), /2026-07-28/);
  assert.equal((await modern('tools/list', {}, { 'Mcp-Method': '' })).status, 400);
  assert.equal((await modern('tools/list', {}, { 'Mcp-Method': 'tools/call' })).status, 400);
  const unsupported = await modern('tools/list', {}, { 'MCP-Protocol-Version': '2099-01-01' });
  assert.equal(unsupported.status, 400);
  assert.match(await unsupported.text(), /-32022/);
  assert.equal((await modern('unknown/method')).status, 404);
  const unknown = await modern('tools/call', { name: 'delete_event', arguments: {} });
  assert.equal(unknown.status, 200);
  assert.match(await unknown.text(), /-32601|-32602/);
  const invalid = await modern('tools/call', { name: 'whatsapp_search', arguments: { limit: 101 } });
  assert.equal(invalid.status, 200);
  assert.match(await invalid.text(), /"isError":true/);
  assert.equal((await fetch(url + '/mcp', { method: 'DELETE', headers: { Authorization: 'Bearer ' + mcpToken } })).status, 405);
  assert.equal(calls.length, 0);
});

test('rate limit refuses calls before the API and recovers after its window', async (t) => {
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  const limited = createService(loadConfig({ ALFRED_API_URL: 'http://127.0.0.1:1',
    ALFRED_API_TOKEN: apiToken, MCP_TOKEN: mcpToken, MCP_RATE_LIMIT: '2' }));
  const target = await listen(limited);
  const send = () => fetch(target + '/mcp', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18', Authorization: 'Bearer ' + mcpToken },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  try {
    for (let i = 0; i < 2; i++) { const reply = await send(); assert.equal(reply.status, 200); await reply.text(); }
    const refused = await send();
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get('retry-after'), '60');
    await refused.text();
    clock += 60_001;
    const recovered = await send(); assert.equal(recovered.status, 200); await recovered.text();
    assert.equal(calls.length, 0);
  } finally { await close(limited); }
});

test('concurrency limit blocks upstream overload and recovers after completion', async () => {
  let enter!: () => void, unblock!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { unblock = resolve; });
  let reads = 0;
  const slow = createServer(async (_req, res) => { reads++; enter(); await released; res.end('{}'); });
  const apiUrl = await listen(slow);
  const limited = createService(loadConfig({ ALFRED_API_URL: apiUrl, ALFRED_API_TOKEN: apiToken,
    MCP_TOKEN: mcpToken, MCP_MAX_CONCURRENT: '1' }));
  const target = await listen(limited);
  const send = () => fetch(target + '/mcp', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18', Authorization: 'Bearer ' + mcpToken },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whatsapp_search', arguments: {} } }) });
  try {
    const first = send(); await entered;
    const refused = await send(); assert.equal(refused.status, 429); await refused.text();
    assert.equal(reads, 1);
    unblock(); const completed = await first; assert.equal(completed.status, 200); await completed.text();
    const recovered = await send(); assert.equal(recovered.status, 200); await recovered.text();
    assert.equal(reads, 2);
  } finally { unblock(); await close(limited); await close(slow); }
});


test('a write without a clear answer reports an unknown outcome instead of advising a retry', async () => {
  for (const failure of ['503', 'invalid']) {
    mode = failure;
    const reply = await call('reminder_create', { title: 'x' });
    assert.equal(reply.result.isError, true);
    const text = JSON.stringify(reply);
    assert.match(text, /outcome is unknown.*List the reminders/);
    assert.doesNotMatch(text, /Retry later/);
  }
});

test('upstream errors give recovery advice without upstream text or credentials', async () => {
  for (const [status, advice] of [
    ['400', /API configured TZ/], ['401', /operator.*credential/], ['failure', /archive\.read/],
    ['404', /Search again/], ['429', /Wait before retrying/], ['503', /not evidence.*absent/],
    ['redirect', /Redirect refused/], ['large', /Reduce limit/], ['invalid', /check API health/],
  ] as [string, RegExp][]) {
    mode = status;
    const reply = await call('whatsapp_search');
    assert.equal(reply.result.isError, true);
    const text = JSON.stringify(reply);
    assert.match(text, advice);
    assert.ok(!text.includes(apiToken) && !text.includes(mcpToken));
  }
});
