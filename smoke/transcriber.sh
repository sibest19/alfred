#!/usr/bin/env bash
# Smoke test of the transcriber image on the CPU (CI has no Intel GPU): the model loads, and a spoken
# sentence comes back as text.
# Image: TRANSCRIBER_IMAGE (default alfred-transcriber:smoke). The model is downloaded into MODELS_DIR
# (default smoke/models), which CI caches.
set -euo pipefail
cd "$(dirname "$0")"

image=${TRANSCRIBER_IMAGE:-alfred-transcriber:smoke}
models=${MODELS_DIR:-models}
mkdir -p "$models"
models=$(cd "$models" && pwd)
name=alfred-smoke-transcriber
work=$(mktemp -d)

finish() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "::group::transcriber logs"
    docker logs "$name" 2>&1 || true
    echo "::endgroup::"
  fi
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -rf "$work"
  exit "$status"
}
trap finish EXIT

sentence='The quick brown fox jumps over the lazy dog.'
if command -v espeak-ng >/dev/null; then
  espeak-ng -v en-us -s 140 -w "$work/clip.wav" "$sentence"
else
  say -o "$work/clip.aiff" "$sentence"
fi
clip=$(ls "$work"/clip.*)

docker run -d --name "$name" -e DEVICE=CPU -v "$models:/models" -p 127.0.0.1:18082:8000 "$image" >/dev/null

# The first run downloads the model (about 1.2 GB)
for _ in $(seq 900); do
  curl -sf http://127.0.0.1:18082/health >/dev/null && break
  if [ "$(docker inspect -f '{{.State.Running}}' "$name")" != true ]; then
    echo 'FAIL: transcriber exited'
    exit 1
  fi
  sleep 1
done
curl -sf http://127.0.0.1:18082/health >/dev/null || {
  echo "FAIL: transcriber healthy (last: $(curl -s http://127.0.0.1:18082/health))"
  exit 1
}
echo 'ok: transcriber healthy'

out=$(curl -sf --data-binary "@$clip" http://127.0.0.1:18082/transcribe)
echo "transcript: $out"
text=$(tr '[:upper:]' '[:lower:]' <<<"$out")
heard=0
for word in quick brown fox lazy dog; do
  [[ $text == *"$word"* ]] && heard=$((heard + 1))
done
if [ "$heard" -lt 3 ]; then
  echo "FAIL: transcript has $heard of the 5 key words"
  exit 1
fi
echo 'transcriber smoke test passed'
