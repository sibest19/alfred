#!/usr/bin/env bash
# The built image loads the Honcho provider through Hermes's own discovery, offline and as a non-root UID.
set -euo pipefail
docker run --rm --network none --read-only --tmpfs /tmp -u 65534:65534 -e HOME=/tmp -e HERMES_HOME=/tmp/hermes \
  --entrypoint /opt/hermes/.venv/bin/python -w /opt/hermes "${HERMES_IMAGE:-alfred-hermes:smoke}" -c '
from plugins.memory import discover_memory_providers, load_memory_provider
import honcho
names = [p[0] for p in discover_memory_providers()]
assert "honcho" in names, names
assert load_memory_provider("honcho", register_skills=False) is not None
print("ok: honcho provider", honcho.__version__ if hasattr(honcho, "__version__") else "")'
