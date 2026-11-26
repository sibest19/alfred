#!/usr/bin/env bash
# Smoke test of the built images against a fresh Postgres:
# - ingest applies the migrations and gets a pairing QR from WhatsApp: the handshake a Baileys or
#   WhatsApp change breaks first (a QR means WhatsApp accepted the client and its version)
# - the API, with its own api_access login and scoped credentials only, answers reads, and its write routes reach
#   their handlers (iCloud and Radicale: not configured); the routes of the retired n8n agent are gone
# Images: INGEST_IMAGE and API_IMAGE (default alfred-ingest:smoke, alfred-api:smoke).
set -euo pipefail
cd "$(dirname "$0")"

dc() { docker compose -p alfred-smoke --profile api "$@"; }
finish() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "::group::service logs"
    dc logs --no-color || true
    echo "::endgroup::"
  fi
  dc down -v --remove-orphans >/dev/null 2>&1 || true
  exit "$status"
}
trap finish EXIT

# Polls until the command succeeds, for up to $1 seconds.
wait_for() {
  local timeout=$1 what=$2
  shift 2
  for _ in $(seq "$timeout"); do
    if "$@" >/dev/null 2>&1; then
      echo "ok: $what"
      return 0
    fi
    sleep 1
  done
  echo "FAIL: $what (after ${timeout}s)"
  return 1
}

dc up -d --wait postgres
dc up -d ingest

health() { curl -s http://127.0.0.1:18080/health; }
wait_for 120 'ingest reached WhatsApp pairing' sh -c "curl -s http://127.0.0.1:18080/health | grep -q '\"waiting_for_pairing\"'" || {
  echo "last ingest health: $(health)"
  exit 1
}

# Migration 008 dropped the retired agent's tables and function
dc exec -T postgres psql -v ON_ERROR_STOP=1 -U assistant -d assistant -q <<'SQL'
DO $$ BEGIN
  ASSERT to_regclass('notes') IS NULL AND to_regclass('consolidations') IS NULL AND to_regclass('reminders') IS NULL, 'tables dropped';
  ASSERT NOT EXISTS (SELECT FROM pg_proc WHERE proname = 'reminder_next'), 'reminder_next dropped';
END $$;
SQL
echo 'ok: migration 008'

dc exec -T postgres psql -v ON_ERROR_STOP=1 -U assistant -d assistant -q \
  -c "CREATE ROLE assistant_api LOGIN PASSWORD 'smoke' IN ROLE api_access"
dc up -d api
wait_for 30 'api healthy' curl -sf http://127.0.0.1:18081/health

api() {
  local method=$1 path=$2 body=${3:-}
  local out code
  out=$(curl -s -w '\n%{http_code}' -X "$method" -H 'Authorization: Bearer smoke-writer-0123456789' \
    ${body:+-H 'Content-Type: application/json' -d "$body"} "http://127.0.0.1:18081$path")
  code=${out##*$'\n'}
  if [[ $code != 2* ]]; then
    echo "FAIL: $method $path -> $code ${out%$'\n'*}"
    return 1
  fi
  echo "ok: $method $path -> $code"
}

api GET '/messages?q=ciao'
api GET '/messages?after_id=0&limit=5'
api GET /stats
api GET '/stats?group_by=day'
api GET /chats
api GET '/contacts?q=rossi'
# Permission checks use real HTTP routes, before any handler can read or modify data.
expect_status() {
  local expected=$1 method=$2 path=$3 token=$4 code
  code=$(curl -s -o /dev/null -w '%{http_code}' -X "$method" -H "Authorization: Bearer $token" "http://127.0.0.1:18081$path")
  [[ $code == "$expected" ]] || { echo "FAIL: $method $path -> $code (expected $expected)"; exit 1; }
  echo "ok: permission $method $path -> $code"
}
for path in /messages /stats /chats '/contacts?q=rossi'; do
  expect_status 200 GET "$path" smoke-reader-0123456789
done
# Unknown tokens, including the retired API_TOKEN's, are refused on every route, removed ones too
for token in wrong-token-0123456789 smoke-token-0123456789; do
  expect_status 401 GET /messages "$token"
  expect_status 401 POST /openrouter/v1/chat/completions "$token"
done
for path in /mail /mail/read /calendar/events /todos; do
  expect_status 403 GET "$path" smoke-reader-0123456789
done
for path in /calendar/events /todos /todos/01234567/done; do
  expect_status 403 POST "$path" smoke-reader-0123456789
done
for path in /calendar/events/01234567 /todos/01234567; do
  expect_status 403 PATCH "$path" smoke-reader-0123456789
  expect_status 403 DELETE "$path" smoke-reader-0123456789
done
# The retired agent's notes, consolidations, reminders, speech-to-text and model proxy: not found, whatever the scope
for path in /notes /notes/topics /consolidations/pending /reminders /openrouter/v1/models; do
  expect_status 404 GET "$path" smoke-writer-0123456789
done
for path in /notes /notes/1/restore /notes/merge /consolidations /reminders /reminders/due /reminders/1/snooze \
  /reminders/1/done /transcribe /openrouter/v1/chat/completions; do
  expect_status 404 POST "$path" smoke-writer-0123456789
done
for path in /notes/1 /reminders/1; do
  expect_status 404 PATCH "$path" smoke-writer-0123456789
  expect_status 404 DELETE "$path" smoke-writer-0123456789
done
expect_status 404 PUT /notes/summaries smoke-writer-0123456789
# iCloud and Radicale aren't configured here: their routes answer 503 past the scope check, which still shows the
# image loads the IMAP and CalDAV libraries
expect_503() {
  local method=$1 path=$2 body=${3:-} code
  code=$(curl -s -o /dev/null -w '%{http_code}' -X "$method" -H 'Authorization: Bearer smoke-writer-0123456789' \
    ${body:+-H 'Content-Type: application/json' -d "$body"} "http://127.0.0.1:18081$path")
  [[ $code == 503 ]] || { echo "FAIL: $method $path -> $code (expected 503)"; exit 1; }
  echo "ok: $method $path -> 503 (not configured)"
}
for path in '/mail?q=smoke' '/mail/read?ids=INBOX:1' /calendar/events /todos; do
  expect_503 GET "$path"
done
expect_503 POST /calendar/events '{"title":"Smoke","start":"2027-01-04 10:00"}'
expect_503 POST /todos '{"title":"Smoke"}'
# The MCP container has only the API link: no database credentials, mounts or direct DB network.
dc up -d --wait mcp
dc exec -T mcp node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { lookup } from 'node:dns/promises';
const token = process.env.MCP_TOKEN;
async function rpc(method, params = {}, credential = token) {
  const res = await fetch('http://127.0.0.1:8080/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      authorization: 'Bearer ' + credential, 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (credential !== token) { assert.equal(res.status, 401); return; }
  assert.equal(res.status, 200);
  const body = await res.text();
  return JSON.parse(res.headers.get('content-type')?.includes('text/event-stream')
    ? body.split('\n').find((line) => line.startsWith('data:')).slice(5) : body);
}
const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
assert.equal(init.result.protocolVersion, '2025-06-18');
const list = await rpc('tools/list');
assert.equal(list.result.tools.length, 16);
for (const [name, args] of [
  ['whatsapp_search', { sender: 'me' }], ['whatsapp_stats', {}],
  ['whatsapp_find_chat', {}], ['whatsapp_find_contact', { q: 'smoke' }],
]) {
  const reply = await rpc('tools/call', { name, arguments: args });
  assert.ok(!reply.error && !reply.result.isError, JSON.stringify(reply));
}
const missing = await rpc('tools/call', { name: 'whatsapp_context', arguments: { id: 999999 } });
assert.equal(missing.result.isError, true);
assert.match(missing.result.content[0].text, /HTTP 404/);
// The smoke credential has only archive.read: mail, calendar and reminders stop at the API with advice naming the scope
for (const [name, scope, args] of [['mail_search', 'mail.read', {}], ['calendar_events', 'calendar.read', {}],
  ['reminders_list', 'todos.read', {}], ['reminder_create', 'todos.manage', { title: 'smoke' }]]) {
  const reply = await rpc('tools/call', { name, arguments: args });
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, new RegExp('HTTP 403.*' + scope.replace('.', '\\.')));
}
const denied = await rpc('tools/call', { name: 'delete_event', arguments: {} });
assert.ok(denied.error || denied.result?.isError);
await rpc('tools/list', {}, process.env.ALFRED_API_TOKEN);
assert.equal(process.getuid(), 1000);
assert.equal(process.env.PGPASSWORD, undefined);
await assert.rejects(lookup('postgres'));
console.log('ok: MCP handshake, archive tools, denied calls, non-root and separate DB network');
JS
echo 'smoke test passed'
