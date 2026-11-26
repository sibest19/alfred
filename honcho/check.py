# One phase of check.sh, inside the built Hermes image: Hermes's own agent loop against a scripted local model, with
# memory.provider honcho and honcho.example.json. store: a turn with the fact reaches Honcho. recall: a new session
# gets it back through Hermes's honcho_search tool. down: with Honcho stopped, a turn still completes.
import http.server
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request

phase, fact, jwt = sys.argv[1], os.environ["CHECK_FACT"], os.environ["CHECK_JWT"]
home = os.environ["HERMES_HOME"]
with open("/check/honcho.example.json") as f:
    honcho = json.load(f)
honcho["apiKey"] = jwt
with open(os.path.join(home, "honcho.json"), "w") as f:
    json.dump(honcho, f)
with open(os.path.join(home, "config.yaml"), "w") as f:
    f.write("memory:\n  provider: honcho\n")

tool_results = []


class Model(http.server.BaseHTTPRequestHandler):
    """Scripted chat completions: a RECALL prompt calls honcho_search for the fact once, anything else gets "ok"."""

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        # Hermes also probes for an Ollama server (/api/show)
        if self.path != "/v1/chat/completions":
            self.send_error(404)
            return
        messages = body["messages"]
        last_user = max(i for i, m in enumerate(messages) if m["role"] == "user")
        tools = [m for m in messages[last_user:] if m["role"] == "tool"]
        tool_results.extend(m["content"] for m in tools)
        names = [t["function"]["name"] for t in body.get("tools") or []]
        if "RECALL" in json.dumps(messages[last_user]["content"]) and not tools and "honcho_search" in names:
            message = {"role": "assistant", "content": None, "tool_calls": [{
                "id": "call_recall", "type": "function",
                "function": {"name": "honcho_search", "arguments": json.dumps({"query": fact})}}]}
        else:
            message = {"role": "assistant", "content": "ok"}
        finish = "tool_calls" if message.get("tool_calls") else "stop"
        base = {"id": "check", "created": 0, "model": body["model"]}
        if body.get("stream"):
            if message.get("tool_calls"):
                message["tool_calls"] = [{"index": 0, **message["tool_calls"][0]}]
            chunks = [{**base, "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": delta, "finish_reason": end}]}
                      for delta, end in ((message, None), ({}, finish))]
            payload = "".join("data: " + json.dumps(c) + "\n\n" for c in chunks) + "data: [DONE]\n\n"
            content_type = "text/event-stream"
        else:
            payload = json.dumps({**base, "object": "chat.completion", "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
                                  "choices": [{"index": 0, "message": message, "finish_reason": finish}]})
            content_type = "application/json"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.end_headers()
        self.wfile.write(payload.encode())

    def log_message(self, *args):
        pass


server = http.server.HTTPServer(("127.0.0.1", 0), Model)
threading.Thread(target=server.serve_forever, daemon=True).start()

# shortcut: pinned Hermes internals, revisit this check when upgrading the Hermes image.
from agent.conversation_loop import run_conversation
from run_agent import AIAgent


def turn(prompt):
    agent = AIAgent(provider="custom", api_mode="chat_completions", base_url="http://127.0.0.1:%d/v1" % server.server_port,
                    api_key="check-model-key", model="check-model", enabled_toolsets=["memory"], max_iterations=4,
                    run_budget_seconds=60, quiet_mode=True, skip_context_files=True, skip_background_review=True)
    try:
        result = run_conversation(agent, prompt)
    finally:
        agent.close()
    assert result.get("completed") and result.get("final_response") == "ok", result
    return result


def honcho_messages():
    from honcho import Honcho
    client = Honcho(base_url=honcho["baseUrl"], api_key=jwt, workspace_id=honcho["workspace"], timeout=10)
    return [m.content for s in client.sessions() for m in s.messages()]


if phase == "store":
    try:
        urllib.request.urlopen(urllib.request.Request(
            honcho["baseUrl"] + "/v3/workspaces/" + honcho["workspace"] + "/sessions/list", data=b"{}",
            headers={"Content-Type": "application/json"}), timeout=10)
    except urllib.error.HTTPError as error:
        assert error.code == 401, error.code
    else:
        raise AssertionError("Honcho answered without a token")
    turn("Remember this for later: the code word is %s." % fact)
    for _ in range(30):
        if any(fact in m for m in honcho_messages()):
            break
        time.sleep(1)
    else:
        raise AssertionError("The turn never reached Honcho: %s" % honcho_messages())
elif phase == "recall":
    turn("RECALL: what is the code word?")
    assert any(fact in r for r in tool_results), tool_results
elif phase == "down":
    started = time.monotonic()
    turn("Honcho is down; answer anyway.")
    assert time.monotonic() - started < 60, time.monotonic() - started
print("ok: honcho " + phase)
