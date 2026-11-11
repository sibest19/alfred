import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const key = readFileSync('/run/model-key/key', 'utf8').trim();
assert.ok(key.length >= 16);
const state = { requests: 0, successes: 0, reserved_usd: 0, cost_usd: 0, providers: [] };
let active = false;
createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/health') { res.end('{"ok":true}'); return; }
  if (req.url === '/state') { res.end(JSON.stringify(state)); return; }
  if (req.url !== '/v1/chat/completions' || req.method !== 'POST') { res.writeHead(404).end(); return; }
  if (req.headers.authorization !== 'Bearer fixture-model-key') { res.writeHead(401).end(); return; }
  if (active || state.requests >= 6) { res.writeHead(429).end('{"error":{"message":"Trial request limit reached"}}'); return; }
  active = true;
  try {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      assert.ok(Buffer.byteLength(raw) <= 256 * 1024);
    }
    const body = JSON.parse(raw);
    const names = (body.tools ?? []).map(t => t.function?.name);
    assert.equal(names.length, 5);
    assert.ok(names.every(n => /^mcp__whatsapp__whatsapp_(search|context|stats|find_chat|find_contact)$/.test(n)));
    assert.ok(!raw.includes('trial-mcp-client-0123456789'));
    // Conservative text-token reservation at the enforced provider price ceilings.
    const reservation = Buffer.byteLength(raw) / 1e6 + 2048 * 3 / 1e6;
    if (state.reserved_usd + reservation > 0.25) {
      res.writeHead(402).end('{"error":{"message":"Trial budget reservation exhausted"}}');
      return;
    }
    state.reserved_usd += reservation;
    state.requests++;
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', redirect: 'error',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'z-ai/glm-5.3', messages: body.messages, tools: body.tools,
        stream: false, max_tokens: 2048, temperature: 0,
        reasoning: { effort: 'low' },
        provider: { zdr: true, data_collection: 'deny', require_parameters: true,
          max_price: { prompt: 1, completion: 3, request: 0 } },
      }),
      signal: AbortSignal.timeout(40_000),
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      const reason = String(failure.error?.message ?? '').replaceAll(key, '[REDACTED]')
        .replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0, 240);
      console.error('OpenRouter returned HTTP ' + response.status + ': ' + reason);
      res.writeHead(response.status).end(JSON.stringify({ error: { message: 'OpenRouter returned HTTP ' + response.status } }));
      return;
    }
    const result = await response.json();
    assert.ok(result.choices?.length);
    state.successes++;
    state.cost_usd += Number(result.usage?.cost ?? 0);
    if (result.provider && !state.providers.includes(result.provider)) state.providers.push(result.provider);
    const base = { id: result.id, created: result.created, model: result.model };
    if (body.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      const choices = result.choices.map(choice => ({ index: choice.index, finish_reason: null,
        delta: { ...choice.message, ...(choice.message.tool_calls ? {
          tool_calls: choice.message.tool_calls.map((tool, index) => ({ index, ...tool })) } : {}) } }));
      res.end('data: ' + JSON.stringify({ ...base, object: 'chat.completion.chunk', choices }) +
        '\n\ndata: ' + JSON.stringify({ ...base, object: 'chat.completion.chunk',
          choices: result.choices.map(choice => ({ index: choice.index, delta: {}, finish_reason: choice.finish_reason })),
          usage: result.usage }) + '\n\ndata: [DONE]\n\n');
    } else {
      res.end(JSON.stringify({ ...base, object: result.object, choices: result.choices, usage: result.usage }));
    }
  } catch {
    res.writeHead(400).end('{"error":{"message":"Trial relay rejected request or upstream failed"}}');
  } finally { active = false; }
}).listen(8080, '0.0.0.0');

