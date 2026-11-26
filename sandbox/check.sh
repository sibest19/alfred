#!/usr/bin/env bash
# The built sandbox behind the built Hermes image's own ssh terminal backend, offline, with throwaway keys and the
# flags of the documented deployment: Hermes's terminal, file and execute_code tools run in the sandbox as its
# unprivileged user on a read-only root without capabilities; Hermes's variables and files stay out of it, nothing it
# writes comes back into Hermes, and it can't forward connections or log in as root.
set -euo pipefail
hermes=${HERMES_IMAGE:-alfred-hermes:smoke}
sandbox=${SANDBOX_IMAGE:-alfred-sandbox:smoke}
name=alfred-sandbox-check
keys=$(mktemp -d)
finish() {
  status=$?
  if [[ $status != 0 ]]; then docker logs "$name" 2>&1 | tail -20 || true; fi
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker network rm "$name" >/dev/null 2>&1 || true
  rm -rf "$keys"
  exit "$status"
}
trap finish EXIT
ssh-keygen -q -t ed25519 -N '' -C check -f "$keys/id"
# A throwaway key, readable by Hermes's UID in the container; the check copies it to a 0600 file there
chmod 644 "$keys/id"
docker network create --internal "$name" >/dev/null
docker run -d --name "$name" --hostname alfred-sandbox --network "$name" --init --read-only --cap-drop ALL \
  --security-opt no-new-privileges --pids-limit 256 --memory 512m \
  --tmpfs /tmp --tmpfs /workspace:uid=1000,gid=1000,mode=0700 \
  -v "$keys/id.pub:/etc/ssh/sandbox/authorized_keys:ro" "$sandbox" >/dev/null

out=$(docker run --rm -i --network "$name" --init --read-only --cap-drop ALL --security-opt no-new-privileges \
  -u 10000:10000 --tmpfs /tmp:mode=1777 --tmpfs /opt/data:uid=10000,gid=10000,mode=0700 \
  -e HOME=/opt/data -e HERMES_HOME=/opt/data -e UV_CACHE_DIR=/tmp/uv -e UV_OFFLINE=1 -e PYTHONDONTWRITEBYTECODE=1 \
  -e HERMES_WRITE_SAFE_ROOT=/opt/data:/workspace -e SANDBOX_HOST="$name" -e ALFRED_MCP_TOKEN=check-secret-0123456789 \
  -v "$keys/id:/check/key:ro" --entrypoint bash "$hermes" -s <<'SH'
set -euo pipefail
install -m 700 -d "$HERMES_HOME/.ssh"
install -m 600 /check/key "$HERMES_HOME/.ssh/sandbox_ed25519"
# As documented: the backend in config.yaml (it overrides TERMINAL_ENV). The passthrough asks Hermes to send a secret,
# which only an sshd accepting it (AcceptEnv) would let in.
cat > "$HERMES_HOME/config.yaml" <<YAML
terminal:
  backend: ssh
  ssh_host: $SANDBOX_HOST
  ssh_port: 2222
  ssh_user: sandbox
  ssh_key: $HERMES_HOME/.ssh/sandbox_ed25519
  env_passthrough: [ALFRED_MCP_TOKEN]
YAML
install -d "$HERMES_HOME/skills/demo"
printf -- '---\nname: demo\ndescription: check\n---\noriginal\n' > "$HERMES_HOME/skills/demo/SKILL.md"
key=(-i "$HERMES_HOME/.ssh/sandbox_ed25519" -p 2222 -o BatchMode=yes -o StrictHostKeyChecking=accept-new)
# -n: ssh would otherwise read the rest of this script from stdin
for _ in $(seq 30); do ssh -nq "${key[@]}" "sandbox@$SANDBOX_HOST" true && break; sleep 1; done
refused() { ! timeout 10 ssh -q "${key[@]}" "$@" </dev/null; }
refused -W "$SANDBOX_HOST:2222" "sandbox@$SANDBOX_HOST" || { echo 'Port forwarding allowed'; exit 1; }
refused "root@$SANDBOX_HOST" true || { echo 'Root login allowed'; exit 1; }
set -- /opt/hermes/tools/uv-*/uv
exec timeout 120 "$1" run --offline --no-sync --project /opt/hermes python - <<'PY'
import json
import os

# shortcut: pinned Hermes internal APIs, revisit this check when upgrading the Hermes image.
import tools.code_execution_tool
import tools.file_tools
import tools.terminal_tool
from tools.registry import registry

def call(name, args):
    reply = json.loads(registry.dispatch(name, args))
    assert not reply.get("error"), reply
    return reply

shell = call("terminal", {"command": (
    "id -u; hostname; awk '$2==\"/\"{print substr($4,1,3)}' /proc/mounts; "
    "grep -E '^(CapBnd|NoNewPrivs):' /proc/self/status; "
    "env | grep -c check-secret || true; "
    "tail -1 ~/.hermes/skills/demo/SKILL.md; "
    "echo INJECTED > ~/.hermes/skills/demo/SKILL.md; echo planted > ~/.hermes/skills/demo/evil.md"
)})
assert shell["output"].split("\n") == [
    "1000", "alfred-sandbox", "ro,", "CapBnd:\t0000000000000000", "NoNewPrivs:\t1", "0", "original",
], shell
# Bridged from config.yaml on the first terminal call
assert os.environ["TERMINAL_ENV"] == "ssh", os.environ.get("TERMINAL_ENV")

call("write_file", {"path": "/workspace/probe.txt", "content": "from hermes\n"})
assert not os.path.exists("/workspace/probe.txt")
assert "from hermes" in call("read_file", {"path": "/workspace/probe.txt"})["content"]

code = call("execute_code", {"code": "import os, socket; print(os.getuid(), socket.gethostname(), open('/workspace/probe.txt').read().strip())"})
assert code["kernel"]["remote"] and code["output"].strip() == "1000 alfred-sandbox from hermes", code

# Closing the backend is when Hermes would copy the sandbox's ~/.hermes back (patched out in hermes/Dockerfile)
environments = list(tools.terminal_tool._active_environments.values())
assert environments
for environment in environments:
    environment.cleanup()
skill = os.path.join(os.environ["HERMES_HOME"], "skills/demo")
assert open(os.path.join(skill, "SKILL.md")).read().endswith("original\n")
assert not os.path.exists(os.path.join(skill, "evil.md"))
print("ok: Hermes terminal, file and execute_code tools run in the sandbox")
PY
SH
) || { echo "$out"; exit 1; }
echo "$out"
# A script cut short (stdin read by another command) exits 0 without running the assertions
[[ $out == *'ok: Hermes terminal'* ]]
