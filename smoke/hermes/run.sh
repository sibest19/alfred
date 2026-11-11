#!/usr/bin/env bash
# Hermes's own MCP discovery/dispatch against an isolated synthetic archive.
set -euo pipefail
cd "$(dirname "$0")"

dc() { docker compose -p alfred-hermes-trial "$@"; }
if [[ -n $(docker ps -aq --filter label=com.docker.compose.project=alfred-hermes-trial) ]]; then
  echo 'Refusing to overwrite an existing alfred-hermes-trial project'
  exit 1
fi
finish() {
  status=$?
  if [[ $status != 0 ]]; then dc logs --no-color api mcp || true; fi
  dc down --volumes --remove-orphans >/dev/null 2>&1 || true
  exit "$status"
}
trap finish EXIT
dc up -d --wait mcp
dc run --rm --no-deps -T hermes
echo 'ok: isolated Hermes MCP trial passed'

