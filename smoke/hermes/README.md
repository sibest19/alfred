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
named Simone. API and MCP use distinct test-only credentials. The default mode uses no real archive,
Telegram bot, external model key or Honcho instance. A local scripted
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

## Optional real-model check

A dedicated, capped and expiring OpenRouter test key can exercise real inference:

```sh
HERMES_TRIAL_REAL=1 TRIAL_OPENROUTER_KEY_FILE=/secure/path/to/key smoke/hermes/run.sh
```

Never put the key in a command argument, environment value, compose file or Git.
The runner transfers the file through stdin into a temporary Docker volume with
UID 1000 ownership and mode 0400. Only the non-root model relay mounts it read-only;
Hermes still has only a dummy relay credential. Cleanup removes the secret volume,
and the runner refuses an existing one rather than overwriting it. An interrupted
host or SIGKILL may leave it behind: inspect the stopped project before deleting it.

Only the relay joins an egress network. Its upstream URL and model are fixed to
OpenRouter and `z-ai/glm-5.3`; caller-supplied model/provider settings are ignored.
It permits six requests, one in flight, 2048 output tokens per call, 40-second
upstream timeouts and at most $0.25 in conservative reservations using provider
price ceilings of $1/M input and $3/M output tokens. The Hermes process has a
180-second wall-clock limit. This relay is a test harness, not a production proxy.
It buffers the bounded upstream reply and adapts it to SSE when Hermes requests it.

Provider preferences require parameter support, deny training/data collection,
and follow account ZDR routing preferences (`zdr:true`). Verify the account's
retention policy before sending personal data; those flags alone are not proof of
a provider's retention behavior. The only model inputs here are synthetic data.

Verified on 2026-11-11 with the pinned Hermes image: four successful real model
calls through provider Decart, reported cost $0.00229445. Hermes invoked chat
lookup, search and context, then correctly cited message 1002 as the owner's
acceptance and message 1003 as the other Simone's refusal, at 18:00. The check
asserts both the final structured answer and actual tool executions. Model
choices and availability can vary on later runs. After rebasing onto updated
Postgres/IMAP dependencies, another successful four-call run through Wafer reported
$0.003083624. One intervening run failed strict answer-format validation; it remains
tracked as HERMES-02 rather than treated as a successful or reliable run.

[MCP gaps](../../mcp/GAPS.md) and production gates remain tracked. The test does
not validate Telegram, Honcho, real-data retention, TrueNAS permissions, full
egress controls or the production gateway lifecycle.
