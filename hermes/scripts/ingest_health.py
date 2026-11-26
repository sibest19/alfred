"""A Hermes no-agent cron script (README.md, Scheduled jobs): says when ingest loses WhatsApp and when it is back.

Hermes delivers what this prints and nothing when it prints nothing, so it speaks only on a change, not on every
check. No model is involved. Reads only ingest's /health, which reports the connection state and nothing else.
The state is saved before Hermes delivers the line: if that delivery fails, the change is not announced again
(`hermes cron list` shows the delivery error).
"""
import http.client
import json
import os
import pathlib
import urllib.error
import urllib.request

url = os.environ.get("INGEST_HEALTH_URL", "http://ingest:8080/health")
state = pathlib.Path(os.environ.get("HERMES_HOME", "/opt/data"), "cron", "ingest_health.state")

try:
    with urllib.request.urlopen(url, timeout=10) as reply:
        up, detail = True, "open"
except urllib.error.HTTPError as error:
    try:
        detail = json.load(error).get("connection") or f"HTTP {error.code}"
    except (ValueError, AttributeError, OSError, http.client.HTTPException):
        detail = f"HTTP {error.code}"
    up = False
except (OSError, http.client.HTTPException) as error:
    up, detail = False, f"unreachable ({type(error).__name__})"

was_up = not state.exists() or state.read_text().strip() != "down"
state.parent.mkdir(parents=True, exist_ok=True)
state.write_text("up" if up else "down")
if was_up and not up:
    print(f"WhatsApp archive is down: ingest reports {detail}. New messages are not being saved until it reconnects.")
elif up and not was_up:
    print("WhatsApp archive is back: ingest is connected again.")
