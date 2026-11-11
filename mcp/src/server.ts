import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { hostHeaderValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node';
import type { Config } from './config.js';
import { createArchiveTools } from './tools.js';

export function createService(config: Config) {
  const handler = createMcpHandler(createArchiveTools(config), { maxRequestBodySize: 16 * 1024, maxSubscriptions: 0 });
  const dispatch = toNodeHandler(handler, { maxRequestBodySize: 16 * 1024 });
  const validateHost = hostHeaderValidation(config.allowedHosts);
  const validateOrigin = originValidation([]);
  const token = Buffer.from(config.mcpToken);
  let windowStarted = Date.now(), requests = 0, active = 0;
  const server = createServer((req, res) => {
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      return;
    }
    if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
    const header = req.headers.authorization;
    const given = Buffer.from(header?.replace(/^Bearer\s+/i, '') ?? '');
    if (!/^Bearer\s+/i.test(header ?? '') || given.length !== token.length || !timingSafeEqual(given, token)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer', 'Content-Type': 'application/json' }).end('{"error":"unauthorized"}');
      return;
    }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }
    const now = Date.now();
    if (now - windowStarted >= 60_000) { windowStarted = now; requests = 0; }
    if (requests >= config.rateLimit || active >= config.maxConcurrent) {
      const retryAfter = active >= config.maxConcurrent ? 1 : Math.max(1, Math.ceil((60_000 - (now - windowStarted)) / 1000));
      res.writeHead(429, { 'Retry-After': String(retryAfter), 'Content-Type': 'application/json' })
        .end('{"error":"MCP request limit reached; retry after the indicated delay"}');
      return;
    }
    requests++;
    active++;
    void dispatch(req, res).catch(() => {
      console.error('MCP request failed');
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }).finally(() => { active--; });
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  server.on('close', () => { void handler.close(); });
  return server;
}
