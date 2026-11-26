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
# The example limits (config.example.yaml): every key exists in this Hermes, and the values Hermes resolves at run time
# are the ones the example sets (the loader alone keeps any value, even one Hermes then ignores or clamps)
run -e HERMES_HOME=/opt/data -v "$(cd "$(dirname "$0")" && pwd)/config.example.yaml:/check/config.yaml:ro" \
  --entrypoint /opt/hermes/.venv/bin/python "$image" -c '
import shutil
shutil.copy("/check/config.yaml", "/opt/data/config.yaml")
# shortcut: pinned Hermes internals, revisit when upgrading the Hermes image.
from hermes_cli.config import load_config, read_raw_config, resolve_turn_limit
from hermes_cli.config_defaults import DEFAULT_CONFIG
example, loaded = read_raw_config(), load_config()
assert example, "config.example.yaml not read"
def leaves(tree, path=()):
    for key, value in tree.items():
        yield from leaves(value, path + (key,)) if isinstance(value, dict) else [(path + (key,), value)]
for path, value in leaves(example):
    default = DEFAULT_CONFIG
    for key in path:
        assert key in default, "not a Hermes setting: " + ".".join(path)
        default = default[key]

from run_agent import AIAgent
from agent.auxiliary_client import _aux_openrouter_settings
from agent.credential_sources import adopt_external_logins_enabled
from agent.title_generator import _auto_title_enabled, _model_title_upgrade_enabled
from hermes_cli.fallback_config import get_fallback_chain
from tools.approval_context import _get_approval_mode
agent = AIAgent(base_url="http://127.0.0.1:9/v1", api_key="x", provider="custom", model="m", quiet_mode=True,
                enabled_toolsets=[])
resolved = {
    "attempts": agent._api_max_retries, "recovery_cycles": agent._auto_recovery_cycles,
    "fallbacks": get_fallback_chain(loaded), "run_budget": agent.run_budget_seconds,
    "max_turns": resolve_turn_limit(loaded["agent"]["max_turns"]), "approvals": _get_approval_mode(),
    "adopt_logins": adopt_external_logins_enabled(), "free_only": _aux_openrouter_settings()[0],
    "auto_titles": _auto_title_enabled(), "title_upgrade": _model_title_upgrade_enabled(),
}
assert resolved == {
    "attempts": 1, "recovery_cycles": 0, "fallbacks": [], "run_budget": 300, "max_turns": 40, "approvals": "manual",
    "adopt_logins": False, "free_only": True, "auto_titles": True, "title_upgrade": False,
}, resolved
print("ok: example limits")'
