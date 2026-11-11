#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
for target in fixture relay; do
  docker run --rm --network none --user 1000:1000 --read-only --cap-drop ALL \
    --security-opt no-new-privileges --pids-limit 64 --memory 128m \
    --tmpfs /run/model-key:rw,size=1m,uid=1000,gid=1000,mode=0700 \
    -v "$PWD:/trial:ro" -e TRIAL_UTF8_TARGET="$target" \
    --entrypoint node "${API_IMAGE:-alfred-api:permissions-test}" /trial/utf8.mjs
done
