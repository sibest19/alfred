#!/usr/bin/env bash
set -euo pipefail
cp /trial/config.yaml "$HERMES_HOME/config.yaml"
set -- /opt/hermes/tools/uv-*/uv
[[ $# == 1 && -x "$1" ]] || { echo 'Expected the pinned Hermes uv runtime'; exit 1; }
exec timeout --signal=TERM --kill-after=5s 90s "$1" run --offline --no-sync --project /opt/hermes python - <<'PY'
import json
import os
import socket
import urllib.error
import urllib.request
from pathlib import Path

# shortcut: pinned Hermes internal APIs, revisit this check when upgrading the image digest.
from tools.mcp_tool_discovery import discover_mcp_tools
from tools.mcp_tool_lifecycle import shutdown_mcp_servers
from tools.registry import registry

expected = {
    "whatsapp_search", "whatsapp_context", "whatsapp_stats",
    "whatsapp_find_chat", "whatsapp_find_contact",
}
assert os.geteuid() == 10000
assert not Path("/var/run/docker.sock").exists()
for key in (
    "PGPASSWORD", "API_TOKEN", "ALFRED_API_TOKEN", "OPENROUTER_API_KEY",
    "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "TELEGRAM_BOT_TOKEN",
):
    assert not os.environ.get(key), key
for host in ("postgres", "api"):
    try:
        socket.getaddrinfo(host, None)
    except socket.gaierror:
        pass
    else:
        raise AssertionError("Unexpected direct network access: " + host)
try:
    connection = socket.create_connection(("1.1.1.1", 443), timeout=1)
except OSError:
    pass
else:
    connection.close()
    raise AssertionError("Unexpected internet egress")

def decoded(value):
    return json.loads(value) if isinstance(value, str) else value

try:
    discovered = discover_mcp_tools(allowed_mcp_names=["whatsapp"])
    names = {}
    for short in expected:
        matches = [name for name in discovered if name.endswith("_" + short)]
        assert len(matches) == 1, (short, discovered)
        names[short] = matches[0]
    assert set(discovered) == set(names.values()), discovered
    assert set(registry.get_tool_names_for_toolset("mcp-whatsapp")) == set(discovered)
    assert registry.get_entry("terminal") is None
    assert registry.get_entry("execute_code") is None

    def call(short, args):
        reply = decoded(registry.dispatch(names[short], args))
        assert "error" not in reply, reply
        return decoded(reply["result"])

    chats = call("whatsapp_find_chat", {"q": "Trial"})
    assert len(chats["chats"]) == 1 and chats["chats"][0]["jid"] == "trial-group@g.us"
    contact = call("whatsapp_find_contact", {"q": "Ada Example"})
    assert contact["contacts"][0]["name"] == "Ada Example"
    mine = call("whatsapp_search", {"chat": "trial-group@g.us", "sender": "me"})
    assert len(mine["messages"]) == 1
    assert mine["messages"][0]["id"] == 1002 and mine["messages"][0]["sender"] == "me"
    context = call("whatsapp_context", {"id": 1002, "before": 2, "after": 2})
    assert [message["id"] for message in context["messages"]] == [1001, 1002, 1003]
    assert context["messages"][1]["target"] is True
    stats = call("whatsapp_stats", {"sender": "me", "group_by": "day"})
    assert stats["total"] == 1

    invalid = decoded(registry.dispatch(names["whatsapp_search"], {"limit": 101}))
    assert invalid.get("error"), invalid
    unknown = decoded(registry.dispatch("mcp_whatsapp_delete_event", {}))
    assert unknown.get("error"), unknown

    request = urllib.request.Request(
        "http://mcp:8080/mcp",
        data=b'{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
        headers={"Content-Type": "application/json", "Authorization": "Bearer wrong-token"},
    )
    try:
        urllib.request.urlopen(request, timeout=5)
    except urllib.error.HTTPError as error:
        assert error.code == 401, error.code
    else:
        raise AssertionError("Invalid MCP token accepted")

    # Exercise the real agent loop; the local endpoint scripts tool choices, not reasoning.
    from run_agent import AIAgent
    from agent.conversation_loop import run_conversation

    for scenario in ("LOOKUP", "DENY", "RECOVER"):
        agent = AIAgent(
            provider="custom", api_mode="chat_completions",
            base_url="http://model:8080/v1", api_key="fixture-model-key", model="fixture-model",
            enabled_toolsets=["mcp-whatsapp"], max_iterations=4, max_tokens=256,
            run_budget_seconds=45, quiet_mode=True, skip_context_files=True,
            skip_memory=True, skip_background_review=True,
        )
        try:
            result = run_conversation(agent, "TRIAL_" + scenario + ": use the available archive tools for this isolated test.")
            assert result.get("final_response") == "TRIAL_" + scenario + "_VERIFIED", result
        finally:
            agent.close()
    with urllib.request.urlopen("http://model:8080/state", timeout=5) as response:
        model_state = json.load(response)
    assert all(model_state[scenario]["verified"] for scenario in ("LOOKUP", "DENY", "RECOVER")), model_state

    print(json.dumps({
        "hermes_mcp_tools": len(discovered),
        "fixture_reads": "passed",
        "sender_me_and_other_simone": "passed",
        "invalid_input_and_unknown_write": "denied",
        "invalid_token": "denied",
        "direct_api_and_database_dns": "unavailable",
        "internet_egress": "unavailable",
        "uid": os.geteuid(),
        "agent_loop_scenarios": model_state,
        "external_model_calls": 0,
    }))
finally:
    shutdown_mcp_servers()
PY
