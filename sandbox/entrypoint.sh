#!/bin/sh
# The host key lives in the workspace volume so it survives restarts (Hermes pins it on first connection). The sandbox
# user can read it anyway, since it runs sshd: it identifies the sandbox to Hermes, not something to hide from the agent.
set -eu
keys=/workspace/.sshd
if [ ! -f "$keys/host_ed25519" ]; then
  mkdir -p -m 700 "$keys"
  ssh-keygen -q -t ed25519 -N '' -C alfred-sandbox -f "$keys/host_ed25519"
fi
[ -r /etc/ssh/sandbox/authorized_keys ] || { echo 'Mount Hermes public key at /etc/ssh/sandbox/authorized_keys' >&2; exit 1; }
exec /usr/sbin/sshd -D -e -f /etc/ssh/sandbox_config
