# alfred

The backend of a private assistant: an archive of a WhatsApp account, an HTTP API over it with a notes store, and local speech-to-text. An agent (an n8n workflow, here) talks to the API only and never holds database credentials.

| Service | | Image |
|---|---|---|
| [`ingest/`](ingest) | Links to WhatsApp as a read-only device and archives every message, edit, reaction, chat, contact and media file into Postgres | `ghcr.io/sibest19/alfred-ingest` |
| [`api/`](api) | Message search, conversation context, counts, chats, contacts, notes and speech-to-text over HTTP, behind a bearer token | `ghcr.io/sibest19/alfred-api` |
| [`transcriber/`](transcriber) | Speech-to-text (Parakeet Ultra, ONNX) on an Intel GPU or the CPU; voice notes become searchable text | `ghcr.io/sibest19/alfred-transcriber` |
| [`db/`](db) | Shared Postgres client and the schema migrations (applied by `ingest`) | |

```
WhatsApp ── ingest ──▶ Postgres ◀── api ◀── agent (n8n, …)
               │                     │
               └──── transcriber ◀───┘
```

All three images are tagged with the release version (`v0.4.0` → `0.4.0`). A compose setup: Postgres (pgvector image), `ingest` with a media volume, `api` with its own role, `transcriber` with the GPU's render device; only `api` needs to be reachable by the agent.

## Development

Node 24, TypeScript, npm workspaces (`db`, `ingest`, `api`): `npm ci && npm run build`, then `node ingest/dist/index.js` or `node api/dist/index.js` with the `PG*` variables set. The transcriber is Python (`transcriber/requirements.txt`). Images build from the repository root (`docker build -f ingest/Dockerfile .`; the transcriber from `transcriber/`). Pushing a `v*` tag publishes all three.

Formerly `wa-ingest` (images `ghcr.io/sibest19/wa-ingest`, `wa-ingest-transcriber`, up to 0.3.0).
