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
api GET /chats
api GET '/contacts?q=rossi'
api POST /notes '{"title":"Smoke","content":"A note from the smoke test","topic":"other"}'
api GET '/notes?q=smoke'
api GET /notes/topics
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
echo 'smoke test passed'
