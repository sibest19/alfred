// Exercise both HTTP readers with a multibyte character split across writes.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { setTimeout } from 'node:timers/promises';

const relay = process.env.TRIAL_UTF8_TARGET === 'relay';
const content = 'TRIAL_LOOKUP: caffè 🍝';
let forwarded = false;
if (relay) {
  writeFileSync('/run/model-key/key', 'synthetic-relay-key-0123456789'); // gitleaks:allow -- synthetic fixture only
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(JSON.parse(options.body).messages[0].content, content);
    forwarded = true;
    return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] });
  };
}
await import(relay ? './openrouter.mjs' : './model.mjs');
const names = ['search', 'context', 'stats', 'find_chat', 'find_contact']
  .map(name => (relay ? 'mcp__whatsapp__' : 'mcp__🍝__') + 'whatsapp_' + name);
const bytes = Buffer.from(JSON.stringify({ model: 'fixture-model',
  messages: [{ role: 'user', content }], tools: names.map(name => ({ type: 'function', function: { name } })) }));
const split = bytes.indexOf(Buffer.from('🍝'), relay ? 0 : bytes.indexOf('"tools"')) + 1;
assert.ok(split > 0);
const reply = new Promise((resolve, reject) => {
  const req = request('http://127.0.0.1:8080/v1/chat/completions', {
    method: 'POST', timeout: 3000, headers: { Authorization: 'Bearer fixture-model-key', 'Content-Type': 'application/json' },
  }, res => {
    let raw = '';
    res.setEncoding('utf8');
    res.on('data', chunk => { raw += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
  });
  req.on('error', reject);
  req.on('timeout', () => req.destroy(new Error('UTF-8 check timed out')));
  req.write(bytes.subarray(0, split));
  void setTimeout(25).then(() => req.end(bytes.subarray(split)));
});
const result = await reply;
assert.equal(result.status, 200);
if (relay) assert.ok(forwarded);
else assert.equal(result.body.choices[0].message.tool_calls[0].function.name, names[0]);
console.log('ok: split UTF-8 preserved by ' + (relay ? 'relay' : 'fixture'));
process.exit(0);
