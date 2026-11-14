# Hermes Agent with Plastic Labs' Honcho memory provider, which the official image lists as an external plugin.
# The provider is pinned to a commit and archive hash, its SDK to a hash-locked requirements file, so nothing is
# downloaded at runtime. The entrypoint runs Hermes's CLI directly instead of the inherited s6 /init, which only starts
# as root or UID 10000: this image runs as any UID with a read-only root filesystem, with HERMES_HOME (/opt/data) as
# its only writable mount. Run it with an init process (`docker run --init`, compose `init: true`).
FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS plugin
# Honcho memory provider v1.2.0
ADD --checksum=sha256:0aa21263ab3beb501bc023216c59682459199c91303f70d0ac57dfc456d8d12b https://api.github.com/repos/plastic-labs/honcho/tarball/894b88321872e01702a1aa638ddfdde6ad60f173 /tmp/honcho.tar.gz
RUN mkdir /plugin && tar -xzf /tmp/honcho.tar.gz --strip-components=2 -C /plugin plastic-labs-honcho-894b883/hermes-plugin-honcho

FROM nousresearch/hermes-agent:v0.23.1@sha256:276d44685c65c0cb2a25f190b63c65c8906f9dc76486fb1c05ae71b5826bda08
COPY --from=plugin /plugin/ /opt/hermes/plugins/memory/honcho/
# honcho-ai and nothing else: the rest of its dependency closure already ships in the Hermes venv
COPY honcho.requirements.txt /tmp/honcho.requirements.txt
RUN set -- /opt/hermes/tools/uv-*/uv; "$1" pip install --python /opt/hermes/.venv/bin/python --require-hashes --no-deps -r /tmp/honcho.requirements.txt \
 && rm /tmp/honcho.requirements.txt
WORKDIR /opt/hermes
ENV HOME=/opt/data
ENTRYPOINT ["/opt/hermes/.venv/bin/python", "-m", "hermes_cli.main"]
CMD ["gateway", "run"]
