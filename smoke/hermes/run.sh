#!/usr/bin/env bash
# Hermes's own MCP discovery/dispatch against an isolated synthetic archive.
set -euo pipefail
cd "$(dirname "$0")"

compose_args=(-p alfred-hermes-trial -f compose.yaml)
if [[ ${HERMES_TRIAL_REAL:-0} == 1 ]]; then compose_args+=(-f real-model.yaml); fi
dc() { docker compose "${compose_args[@]}" "$@"; }
if [[ -n $(docker ps -aq --filter label=com.docker.compose.project=alfred-hermes-trial) ]]; then
  echo 'Refusing to overwrite an existing alfred-hermes-trial project'
  exit 1
fi
finish() {
  status=$?
  if [[ $status != 0 ]]; then dc logs --no-color api mcp model || true; fi
  dc down --volumes --remove-orphans >/dev/null 2>&1 || true
  if [[ ${key_volume_created:-0} == 1 ]]; then docker volume rm alfred-hermes-trial-model-key >/dev/null; fi
  exit "$status"
}
trap finish EXIT
./utf8.sh
if [[ ${HERMES_TRIAL_REAL:-0} == 1 ]]; then
  [[ -r ${TRIAL_OPENROUTER_KEY_FILE:-} ]] || { echo 'A readable secure key file is required'; exit 1; }
  if docker volume inspect alfred-hermes-trial-model-key >/dev/null 2>&1; then
    echo 'Refusing to overwrite an existing model-key volume'
    exit 1
  fi
  docker volume create alfred-hermes-trial-model-key >/dev/null
  key_volume_created=1
  docker run --rm -i --network none --user 0 --read-only --cap-drop ALL --cap-add CHOWN \
    --security-opt no-new-privileges \
    -v alfred-hermes-trial-model-key:/secret --entrypoint node "${API_IMAGE:-alfred-api:permissions-test}" \
    -e 'const fs=require("node:fs");const key=fs.readFileSync(0);fs.writeFileSync("/secret/key",key,{mode:0o400});fs.chownSync("/secret/key",1000,1000)' \
    < "$TRIAL_OPENROUTER_KEY_FILE"
fi
dc up -d --wait mcp model
dc run --rm --no-deps -T hermes
echo 'ok: isolated Hermes MCP trial passed'

