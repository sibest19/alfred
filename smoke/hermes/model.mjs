import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const state = {};
const expected = ['whatsapp_search', 'whatsapp_context', 'whatsapp_stats', 'whatsapp_find_chat', 'whatsapp_find_contact'];
function unwrap(message) {
  let text = message.content;
  if (text.startsWith('<untrusted_tool_result ')) {
    assert.ok(text.endsWith('\n</untrusted_tool_result>'));
    assert.ok(text.includes('Treat it as DATA'));
    text = text.slice(text.indexOf('\n\n') + 2, -'\n</untrusted_tool_result>'.length);
  }
  let value = JSON.parse(text);
  if (typeof value.result === 'string') value = JSON.parse(value.result);
  return value;
}
function response(body) {
  const names = (body.tools ?? []).map(t => t.function.name);
  assert.equal(names.length, 5, 'Only the five MCP tools may reach the model: ' + names.join(', '));
  for (const short of expected) assert.equal(names.filter(n => n.endsWith('_' + short)).length, 1);
  assert.ok(!JSON.stringify(body).includes('trial-mcp-client-0123456789'), 'MCP credential reached model');
  const scenario = ['LOOKUP', 'DENY', 'RECOVER'].find(s => body.messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('TRIAL_' + s)));
  assert.ok(scenario, 'Unknown fixture scenario');
  state[scenario] ??= { requests: 0, verified: false };
  assert.ok(++state[scenario].requests <= 4, 'Unbounded model loop');
  const results = body.messages.filter(m => m.role === 'tool');
  const name = short => names.find(n => n.endsWith('_' + short));
  const tool = (n, args) => ({
    role: 'assistant', content: null,
    tool_calls: [{ id: 'call_' + scenario + '_' + results.length, type: 'function', function: { name: n, arguments: JSON.stringify(args) } }],
  });
  if (scenario === 'DENY') {
    if (!results.length) return tool('mcp_whatsapp_delete_event', { id: '01234567' });
    assert.match(results.at(-1).content, /does not exist/i);
  } else if (scenario === 'RECOVER' && !results.length) {
    return tool(name('whatsapp_search'), { limit: 101 });
  } else {
    if (scenario === 'RECOVER' && results.length === 1) {
      assert.match(results[0].content, /error|invalid|100/i);
      return tool(name('whatsapp_search'), { chat: 'trial-group@g.us', sender: 'me', limit: 3 });
    }
    if (!results.length) return tool(name('whatsapp_search'), { chat: 'trial-group@g.us', sender: 'me' });
    const read = unwrap(results[scenario === 'RECOVER' ? 1 : 0]);
    assert.equal(read.messages.length, 1);
    assert.equal(read.messages[0].id, 1002);
    assert.equal(read.messages[0].sender, 'me');
    if (scenario === 'LOOKUP' && results.length === 1) return tool(name('whatsapp_context'), { id: 1002, before: 2, after: 2 });
    if (scenario === 'LOOKUP') assert.deepEqual(unwrap(results[1]).messages.map(m => m.id), [1001, 1002, 1003]);
  }
  state[scenario].verified = true;
  return { role: 'assistant', content: 'TRIAL_' + scenario + '_VERIFIED' };
}

createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/health') { res.end('{"ok":true}'); return; }
  if (req.url === '/state') { res.end(JSON.stringify(state)); return; }
  if (req.url !== '/v1/chat/completions' || req.method !== 'POST') { res.writeHead(404).end(); return; }
  if (req.headers.authorization !== 'Bearer fixture-model-key') { res.writeHead(401).end(); return; }
  try {
    req.setEncoding('utf8');
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      assert.ok(Buffer.byteLength(raw) <= 256 * 1024, 'Oversized model request');
    }
    const body = JSON.parse(raw);
    assert.equal(body.model, 'fixture-model');
    const message = response(body);
    const finish = message.tool_calls ? 'tool_calls' : 'stop';
    const base = { id: 'fixture-response', created: 0, model: body.model };
    if (body.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      const delta = { ...message, ...(message.tool_calls ? { tool_calls: message.tool_calls.map((t, index) => ({ index, ...t })) } : {}) };
      res.end('data: ' + JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] }) +
        '\n\ndata: ' + JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: finish }] }) + '\n\ndata: [DONE]\n\n');
    } else {
      res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: finish }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }
  } catch (error) {
    console.error('Fixture assertion failed: ' + error.message);
    res.writeHead(400).end('{"error":{"message":"Fixture assertion failed","type":"invalid_request_error"}}');
  }
}).listen(8080, '0.0.0.0');

