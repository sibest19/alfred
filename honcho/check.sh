#!/usr/bin/env bash
# Honcho as the built Hermes image's memory, offline: compose.yaml with JWT auth on and Honcho's own mock model
# provider (compose.check.yaml), and Hermes non-root on a read-only root, only on the internal honcho network, running
# check.py. A fact one session stores comes back in a new session through Hermes's honcho_search, after Honcho's
# database is dumped and restored into a fresh one (README.md, Backup); with Honcho stopped, a turn still completes.
set -euo pipefail
cd "$(dirname "$0")"
hermes=${HERMES_IMAGE:-alfred-hermes:smoke}
project=alfred-honcho-check
dc() { docker compose -p "$project" -f compose.yaml -f compose.check.yaml "$@"; }
if [[ -n $(docker ps -aq --filter "label=com.docker.compose.project=$project") ]] || docker inspect "$project-hermes" >/dev/null 2>&1; then
  echo "Refusing to overwrite an existing $project project"
  exit 1
fi
tmp=$(mktemp -d)
finish() {
  status=$?
  if [[ $status != 0 ]]; then dc logs --tail 20 2>&1 || true; fi
  docker rm -f "$project-hermes" >/dev/null 2>&1 || true
  dc down -v >/dev/null 2>&1 || true
  rm -rf "$tmp"
  exit "$status"
}
trap finish EXIT
export HONCHO_DB_PASSWORD HONCHO_JWT_SECRET HONCHO_OPENROUTER_KEY=check-model-key HONCHO_MODEL=check-model
HONCHO_DB_PASSWORD=$(openssl rand -hex 16)
HONCHO_JWT_SECRET=$(openssl rand -hex 32)
# Honcho downloads two tokenizer files at start; tiktoken checks their hashes. Fetched here, so Honcho stays offline.
export HONCHO_CHECK_TIKTOKEN=$tmp/tiktoken
mkdir -m 755 "$HONCHO_CHECK_TIKTOKEN"
for encoding in o200k_base:fb374d419588a4632f3f557e76b4b70aebbca790 cl100k_base:9b5ad71b2ce5302211f9c61530b329a4922fc6a4; do
  curl -fsS --retry 3 --max-time 60 -o "$HONCHO_CHECK_TIKTOKEN/${encoding#*:}" \
    "https://openaipublic.blob.core.windows.net/encodings/${encoding%%:*}.tiktoken"
done
chmod 644 "$HONCHO_CHECK_TIKTOKEN"/*

dc up -d --wait --wait-timeout 180
jwt=$(dc exec -T honcho /app/.venv/bin/python scripts/generate_jwt.py --workspace hermes --print-only)
docker run -d --name "$project-hermes" --network "${project}_honcho" --init --read-only --cap-drop ALL \
  --security-opt no-new-privileges -u 10000:10000 --tmpfs /tmp:mode=1777 --tmpfs /opt/data:uid=10000,gid=10000,mode=0700 \
  -e HOME=/opt/data -e HERMES_HOME=/opt/data -e UV_CACHE_DIR=/tmp/uv -e UV_OFFLINE=1 -e PYTHONDONTWRITEBYTECODE=1 \
  -e CHECK_FACT="zephyr-$(openssl rand -hex 6)" -e CHECK_JWT="$jwt" -v "$PWD:/check:ro" \
  --entrypoint sleep "$hermes" infinity >/dev/null
phase() { docker exec "$project-hermes" timeout 180 /opt/hermes/.venv/bin/python /check/check.py "$1"; }

phase store
dc exec -T honcho-db pg_dump -U honcho -d honcho >"$tmp/honcho.sql"
dc rm -sf honcho honcho-deriver honcho-db
docker volume rm "${project}_honcho-db" >/dev/null
dc up -d --wait --wait-timeout 60 honcho-db
dc exec -T honcho-db psql -X -q -v ON_ERROR_STOP=1 -U honcho -d honcho <"$tmp/honcho.sql" >/dev/null
dc up -d --wait --wait-timeout 180
phase recall
dc stop honcho
phase down
