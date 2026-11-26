# Alfred's sandbox

A container where Alfred's shell runs. Hermes's [ssh terminal backend](https://github.com/NousResearch/hermes-agent/blob/v0.23.3/website/docs/user-guide/configuration.md#ssh-backend)
sends its `terminal`, file (`read_file`, `write_file`, `patch`, `search_files`) and `execute_code` tools here, so
the commands a model writes (after reading untrusted WhatsApp messages and mail) never run inside Hermes, next to its
model key, Telegram token, MCP credential and memory.

```
Telegram ── Hermes ──ssh──▶ sandbox (/workspace)
               │
               └── mcp ── api ── Postgres      (the sandbox has no route here)
```

What keeps it contained:

- **No credentials.** Hermes's environment is not sent over SSH, and sshd accepts no forwarded variables (no
  `AcceptEnv`). The sandbox is on its own network with Hermes, not on the MCP, API or database networks.
- **Nothing comes back.** Before each command Hermes uploads its skills and caches (Telegram attachments, spilled-over
  tool results, so archive excerpts too) to the sandbox's `~/.hermes`. Hermes would copy that tree back when it closes
  the connection, letting one command plant a skill every later session loads: [`hermes/Dockerfile`](../hermes/Dockerfile)
  removes that copy. It would also upload any credential file in `terminal.credential_files` or a skill's
  `required_credential_files`: keep both empty.
- **No privileges.** sshd and every command run as UID 1000 on a read-only root, with no capabilities,
  `no-new-privileges`, and PID and memory limits. No Docker socket anywhere: Hermes only has an SSH client.
- **No tunnels.** Key-only login as `sandbox`; TCP, socket, agent and X11 forwarding and tunnels are off, so the
  sandbox is not a proxy into Hermes's network.
- **Approvals still apply.** Unlike Hermes's container backends, the ssh backend keeps Hermes's dangerous-command
  checks: on Telegram they follow `approvals.mode` (`smart` by default: an auxiliary model passes low-risk commands
  and asks the owner about uncertain ones); cron and API-server (inbox) runs deny them (`approvals.cron_mode`,
  `unattended_mode`, both `deny` by default).

What it does not stop: the sandbox reaches Hermes itself on their shared network, so any listener Hermes has there
(its API server, if enabled, listens on all interfaces) is protected by its own key only. And `execute_code` scripts
can call Hermes's web tools, which run in Hermes with Hermes's internet access, so a sandbox without internet is not
an exfiltration boundary.

[`check.sh`](check.sh) verifies the properties above against the built Hermes image in CI, offline with throwaway
keys and the flags below, including that a sandbox accepting forwarded variables or an unpatched Hermes fails it.

## Deployment

A key pair for Hermes in its data volume, owned by the UID Hermes runs as; only the public key goes to the sandbox:

```sh
mkdir -p -m 700 <hermes-data>/.ssh
ssh-keygen -t ed25519 -N '' -C alfred-hermes -f <hermes-data>/.ssh/sandbox_ed25519
chown -R <hermes-uid>:<hermes-gid> <hermes-data>/.ssh
```

Compose, next to the existing Hermes service:

```yaml
services:
  sandbox:
    image: ghcr.io/sibest19/alfred-sandbox:<version>
    restart: unless-stopped
    init: true
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    pids_limit: 256
    mem_limit: 1g
    cpus: 1
    tmpfs: [/tmp]
    volumes:
      - sandbox-workspace:/workspace
      - <hermes-data>/.ssh/sandbox_ed25519.pub:/etc/ssh/sandbox/authorized_keys:ro
    networks: [sandbox]
  hermes:
    # ...as today, plus:
    environment:
      # The image allows file writes under /opt/data only; /workspace is in the sandbox
      HERMES_WRITE_SAFE_ROOT: /opt/data:/workspace
    networks: [sandbox] # in addition to its current ones
volumes:
  sandbox-workspace:
networks:
  sandbox:
    internal: true
```

Hermes's `config.yaml`. Set the backend here, not with `TERMINAL_ENV`: a `terminal.backend` in this file (the setup
wizard writes one) overrides the variable, and `local` would run the shell inside Hermes.

```yaml
terminal:
  backend: ssh
  ssh_host: sandbox
  ssh_port: 2222
  ssh_user: sandbox
  ssh_key: /opt/data/.ssh/sandbox_ed25519
  credential_files: []
```

`hermes dump` shows the backend in effect. Then turn on the `terminal`, `file` and `code_execution` toolsets for
Telegram (`hermes tools`). Leave them off `platform_toolsets.api_server`: callers of the
[inbox MCP](../mcp/README.md#incoming-requests-to-alfred) should not get a shell.

The model runs as the same user as sshd, so it can stop it or delete its host key: the restart policy brings it back,
and Hermes pins the host key on first connection (`/opt/data/.ssh/known_hosts`, hashed). After a new host key (the key
deleted, or the volume recreated), forget the old one once:

```sh
ssh-keygen -R '[sandbox]:2222' -f <hermes-data>/.ssh/known_hosts
```

The workspace volume has no size limit of its own: on a disk shared with Postgres, put it on a sized filesystem or
under a quota.

### Internet access

On the internal network above the sandbox has no internet: enough for scripts, files and data work, not for
`pip install`, `git clone` or `curl`. To allow those, also attach it to a regular network:

```yaml
    networks: [sandbox, sandbox-egress]
networks:
  sandbox-egress: {}
```

That network also reaches the host and the LAN. Block them on the host before enabling it, for example (Linux,
replace the subnet with the network's):

```sh
iptables -I DOCKER-USER -s <sandbox-egress subnet> -d 10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,100.64.0.0/10 -j DROP
iptables -I INPUT -s <sandbox-egress subnet> -j DROP
```

Docker's embedded DNS still works. These rules are an example and have not been verified here (IPv6 included):
check from inside the sandbox that the router, the host and the other containers are unreachable.

### Stronger isolation

The sandbox shares the host kernel. Where [gVisor](https://gvisor.dev) is installed, `runtime: runsc` on the sandbox
service adds a kernel boundary; not exercised here.

## Build and check

```sh
docker build -t alfred-hermes:smoke hermes/
docker build -t alfred-sandbox:smoke sandbox/
sandbox/check.sh
```

Tools in the image: bash, Python 3 (with venv; `execute_code` needs it), git, curl, jq, ripgrep, file, unzip, xz,
procps. Anything else the agent installs under `/workspace`.
