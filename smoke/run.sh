#!/usr/bin/env bash
# Smoke test of the built images against a fresh Postgres:
# - ingest applies the migrations and gets a pairing QR from WhatsApp: the handshake a Baileys or
#   WhatsApp change breaks first (a QR means WhatsApp accepted the client and its version)
# - the API, with its own api_access login, answers reads and writes (iCloud's routes: not configured)
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

# reminder_next(), the repeat math of reminders: known answers for its tricky cases (Rome changes clocks on
# 2026-03-29 and 2026-10-25)
dc exec -T postgres psql -v ON_ERROR_STOP=1 -U assistant -d assistant -q <<'SQL'
DO $$ BEGIN
  -- monthly from the 31st: the last day of a shorter month, then back to the 31st (now in summer time)
  ASSERT reminder_next('2026-01-31 09:00', 'month', 1, NULL, NULL, '2026-02-01 00:00+01', 'Europe/Rome') = '2026-02-28 09:00+01', 'monthly 31st -> Feb 28';
  ASSERT reminder_next('2026-01-31 09:00', 'month', 1, NULL, NULL, '2026-02-28 09:00+01', 'Europe/Rome') = '2026-03-31 09:00+02', 'monthly 31st -> Mar 31';
  -- daily at 09:00 stays at 09:00 local across the change back to winter time
  ASSERT reminder_next('2026-10-20 09:00', 'day', 1, NULL, NULL, '2026-10-24 10:00+02', 'Europe/Rome') = '2026-10-25 09:00+01', 'daily across DST';
  -- every 2 weeks on Monday and Thursday from Monday 2026-11-02: Nov 2, Nov 5, then Nov 16
  ASSERT reminder_next('2026-11-02 09:00', 'week', 2, '{1,4}', NULL, '2026-11-02 09:00+01', 'Europe/Rome') = '2026-11-05 09:00+01', 'biweekly -> Thu';
  ASSERT reminder_next('2026-11-02 09:00', 'week', 2, '{1,4}', NULL, '2026-11-05 09:00+01', 'Europe/Rome') = '2026-11-16 09:00+01', 'biweekly skips a week';
  -- past until: no next occurrence
  ASSERT reminder_next('2026-11-02 09:00', 'day', 1, NULL, '2026-11-04 00:00+01', '2026-11-03 09:00+01', 'Europe/Rome') IS NULL, 'until ends it';
END $$;
SQL
echo 'ok: reminder_next'

dc exec -T postgres psql -v ON_ERROR_STOP=1 -U assistant -d assistant -q \
  -c "CREATE ROLE assistant_api LOGIN PASSWORD 'smoke' IN ROLE api_access"
dc up -d api
wait_for 30 'api healthy' curl -sf http://127.0.0.1:18081/health

api() {
  local method=$1 path=$2 body=${3:-}
  local out code
  out=$(curl -s -w '\n%{http_code}' -X "$method" -H 'Authorization: Bearer smoke-token-0123456789' \
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
expect_status 401 GET /messages wrong-token
for path in /notes /notes/topics /consolidations/pending /reminders /mail /mail/read /calendar/events; do
  expect_status 403 GET "$path" smoke-reader-0123456789
done
for path in /notes /notes/1/restore /notes/merge /consolidations /reminders /reminders/due /reminders/1/snooze /reminders/1/done /calendar/events /transcribe; do
  expect_status 403 POST "$path" smoke-reader-0123456789
done
for path in /notes/1 /reminders/1 /calendar/events/01234567; do
  expect_status 403 PATCH "$path" smoke-reader-0123456789
  expect_status 403 DELETE "$path" smoke-reader-0123456789
done
expect_status 403 PUT /notes/summaries smoke-reader-0123456789
# API credentials must never be forwarded to an external model provider.
expect_status 403 POST /openrouter/v1/chat/completions smoke-reader-0123456789
expect_status 403 POST /openrouter/v1/chat/completions smoke-token-0123456789
api POST /notes '{"title":"Smoke","content":"A note from the smoke test","topic":"other"}'
api GET '/notes?q=smoke'
api GET /notes/topics
# twice: the second replaces the first
api PUT /notes/summaries '{"topic":"other","content":"Smoke summary"}'
api PUT /notes/summaries '{"topic":"other","content":"Smoke summary, again"}'
# started_at as the consolidation workflow sends it ($now.toISO())
api POST /consolidations '{"started_at":"2026-11-01T22:00:00.123+01:00","changes":0}'
api GET /consolidations/pending
tomorrow=$(TZ=Europe/Rome date -d '+1 day' '+%Y-%m-%d %H:%M' 2>/dev/null || TZ=Europe/Rome date -v+1d '+%Y-%m-%d %H:%M')
api POST /reminders "{\"text\":\"Smoke\",\"due\":\"$tomorrow\"}"
api POST /reminders "{\"text\":\"Smoke check\",\"due\":\"$tomorrow\",\"kind\":\"check\"}"
api GET /reminders
api GET '/reminders?kind=check'
# iCloud isn't configured here: its routes answer 503, which still shows the image loads the IMAP and CalDAV libraries
for path in '/mail?q=smoke' '/mail/read?ids=INBOX:1' /calendar/events; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer smoke-token-0123456789' "http://127.0.0.1:18081$path")
  [[ $code == 503 ]] || { echo "FAIL: GET $path -> $code (expected 503)"; exit 1; }
  echo "ok: GET $path -> 503 (iCloud not configured)"
done
# the model route marks Claude prompts for caching (the system prompt but its last paragraph, the latest user message)
dc exec -T api node --input-type=module -e "
import assert from 'node:assert/strict';
import { withCache } from './dist/llm.js';
const b = withCache({ model: 'anthropic/x', messages: [{ role: 'system', content: 'rules\n\nNow: 10:00' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }, { role: 'tool', content: 'r' }] });
assert.deepEqual(b.messages[0].content.map((p) => [p.text, p.cache_control?.ttl]), [['rules', '1h'], ['\n\nNow: 10:00', undefined]]);
assert.equal(b.messages[1].content[0].cache_control.type, 'ephemeral');
assert.equal(typeof withCache({ model: 'z-ai/glm', messages: [{ role: 'system', content: 'a\n\nb' }] }).messages[0].content, 'string');
"
echo 'ok: model route cache marks'
echo 'smoke test passed'
