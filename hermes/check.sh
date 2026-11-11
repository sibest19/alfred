#!/usr/bin/env bash
# The built image, offline, as an arbitrary non-root UID with a read-only root: its own entrypoint starts the CLI, and
# the Honcho provider loads through Hermes's own discovery.
set -euo pipefail
image=${HERMES_IMAGE:-alfred-hermes:smoke}
run() { docker run --rm --init --network none --read-only --tmpfs /tmp --tmpfs /opt/data:uid=65534,gid=65534 -u 65534:65534 "$@"; }
run "$image" --help >/dev/null
run --entrypoint /opt/hermes/.venv/bin/python "$image" -c '
from plugins.memory import discover_memory_providers, load_memory_provider
import honcho
names = [p[0] for p in discover_memory_providers()]
assert "honcho" in names, names
assert load_memory_provider("honcho", register_skills=False) is not None
print("ok: honcho provider", honcho.__version__ if hasattr(honcho, "__version__") else "")'
