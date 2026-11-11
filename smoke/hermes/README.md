# Isolated Hermes → MCP trial

Run from the repository root: `smoke/hermes/run.sh`.

Prerequisites: Docker and locally built `alfred-api:permissions-test`,
`alfred-ingest:smoke` and `alfred-mcp:smoke` from this preparation branch:

```sh
docker build -f api/Dockerfile -t alfred-api:permissions-test .
docker build -f ingest/Dockerfile -t alfred-ingest:smoke .
docker build -f mcp/Dockerfile -t alfred-mcp:smoke .
smoke/hermes/run.sh
```

Image overrides: `API_IMAGE`, `INGEST_IMAGE`, `MCP_IMAGE`. Hermes is pinned in
`compose.yaml` to official image manifest digest
`sha256:276d44685c65c0cb2a25f190b63c65c8906f9dc76486fb1c05ae71b5826bda08`.
The trial does not follow a floating tag. It was exercised on Linux arm64 through
Docker Desktop; other architectures and TrueNAS have not been exercised.

## What it runs

The one-shot migration job uses the ingest image's database module only: it
never starts a WhatsApp session. The seed job inserts three synthetic messages
into an ephemeral Postgres, including Simone's own message and another person
named Simone. API and MCP use distinct test-only credentials. No real archive,
Telegram bot, external model key or Honcho instance is involved. A local scripted
OpenAI-compatible endpoint exercises the real Hermes agent loop without inference.

Hermes runs non-root (UID 10000), with read-only root, capabilities dropped,
`no-new-privileges`, an init process, PID/memory limits, and fresh
tmpfs state. Its only mounted files are the check script and fixture config.
No ports are published and all three trial networks are internal:

```text
Hermes ── hermes network ── MCP ── api network ── API ── database network ── Postgres
```

The official image's normal entrypoint is replaced for this one-shot check;
this does not validate the s6 gateway's production startup. The check invokes
Hermes's own `discover_mcp_tools`, tool registry `dispatch`, and `AIAgent`
conversation loop, using its pinned Python 3.14 environment through bundled uv,
offline and without dependency sync. The local endpoint scripts tool choices and
checks returned fixture data before producing its final response; it does not
evaluate a real model's reasoning. The optional tool-search bridge is explicitly
off so the model receives the five tools directly, with no native tools added.

The agent scenarios verify lookup plus conversation context, refusal of an
unavailable calendar-write tool, and recovery from invalid search arguments.
They use eight local model-endpoint requests (3 + 2 + 3) and zero external model
calls. MCP result envelopes remain marked as untrusted data by Hermes.

## Verified on 2026-11-11

- Five MCP tools discovered with an explicit include list; native terminal/code
  tools absent from this check's registry.
- Real scoped API reads for chat/contact lookup, messages, context and statistics.
- Only `sender=me` identifies the owner's message; the other Simone stays separate.
- Oversized tool arguments and an unregistered calendar-write tool rejected.
- A wrong inbound token rejected with HTTP 401.
- Direct API/Postgres service DNS unavailable from Hermes; connecting to
  `1.1.1.1:443` fails. This is not a complete host/LAN/IPv6 egress test.
- No external model calls, production credentials, Docker socket or persistent state.

The whole Hermes check has a 90-second wall-clock timeout with a five-second
termination grace. This bounds the test even if internal provider retries run
past `run_budget_seconds`; that behavior was observed with a failing fixture.
Fixture assertion errors return HTTP 400 so they fail fast rather than triggering
the provider's transient-error backoff.

The runner refuses an existing project with the same name, then cleans up its
own containers, networks and volumes on success or failure. PostgreSQL and Hermes
state live in tmpfs; the only persistent output is the image cache and these test
artifacts. The trial is manual and is not yet part of hosted CI.

[MCP gaps](../../mcp/GAPS.md) remain open. Next verification is a real-model
conversation with synthetic data and a dedicated test credential; only then should
production bot, data and host-specific deployment settings enter the pilot.
