# A shell for Alfred: Hermes's ssh terminal backend runs its terminal, file and execute_code tools here, so commands
# never run inside Hermes itself, next to its credentials and memory. sshd runs as the unprivileged sandbox user
# (only that user can log in), on a read-only root, with /workspace (also HOME) as its only persistent mount.
FROM debian:trixie-slim@sha256:8aa5a7bf5a1955bddbe7d74fcdd0b91ab30e74362a8b73af672b0481b35b44a0
# python3 is required by Hermes's execute_code on a remote backend; the rest is a general-purpose CLI toolbox
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server bash ca-certificates curl git jq less procps \
    python3 python3-venv ripgrep file unzip xz-utils \
 && rm -rf /var/lib/apt/lists/* /etc/ssh/ssh_host_* \
 && useradd --uid 1000 --home-dir /workspace --shell /bin/bash sandbox \
 && mkdir -p /workspace && chown sandbox:sandbox /workspace
COPY sshd_config /etc/ssh/sandbox_config
COPY --chmod=755 entrypoint.sh /usr/local/bin/sandbox-entrypoint
USER sandbox
WORKDIR /workspace
EXPOSE 2222
ENTRYPOINT ["/usr/local/bin/sandbox-entrypoint"]
