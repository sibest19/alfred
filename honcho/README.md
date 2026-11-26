# Honcho

Hermes's long-term memory: a self-hosted [Honcho](https://github.com/plastic-labs/honcho) server, which keeps the
conversations Hermes has, derives conclusions about the user from them with a model, and answers Hermes's recall.
[`compose.yaml`](compose.yaml) runs it; Hermes talks to it through the Honcho memory provider pinned in its
[image](../hermes/Dockerfile).

| | Version |
|---|---|
| Server | `ghcr.io/plastic-labs/honcho:v3.6.0`, pinned by digest in `compose.yaml` |
| Hermes's provider | plastic-labs/honcho commit `894b883` (`hermes-plugin-honcho` 1.2.0): v3.6.0 plus one commit that changes only the plugin |
| SDK in Hermes | `honcho-ai` 2.2.0 ([`honcho.requirements.txt`](../hermes/honcho.requirements.txt)) |

[`check.sh`](check.sh) proves the three work together, offline, on every CI run (`smoke` job): Honcho from
`compose.yaml` with authentication on and Honcho's own deterministic mock model provider in place of OpenRouter
([`compose.check.yaml`](compose.check.yaml)); the built Hermes image, non-root on a read-only root and only on the
`honcho` network, runs its own agent loop against a scripted local model ([`check.py`](check.py)). A turn stating a
random code word reaches Honcho; Honcho's database is dumped and restored into a fresh one; a new Hermes session gets
the code word back through Hermes's `honcho_search` tool; then, with Honcho stopped, a turn still completes. It fails
if `memory.provider` is unset, if Hermes's token is signed with another secret, or if Honcho accepts requests without
one. Run it after building the Hermes image (`docker build -t alfred-hermes:smoke hermes/`); only the host goes
online, for the tokenizer files below. About 40 s once the images are pulled.

## Services

| Service | Role | Networks |
|---|---|---|
| `honcho` | The API, on port 8000 (not published). Applies the database migrations at start | `honcho`, `honcho-db`, `honcho-models` |
| `honcho-deriver` | Background worker: derives conclusions, summaries and dreams from stored messages | `honcho-db`, `honcho-models` |
| `honcho-db` | Postgres with pgvector, in the `honcho-db` volume: all of Honcho's data | `honcho-db` |

`honcho` and `honcho-db` are internal networks: add Hermes to `honcho` and nothing else reaches the API (Hermes
names it `honcho:8000`). `honcho-models` is an ordinary bridge network: the way out to the model provider, and at
start to `openaipublic.blob.core.windows.net`, where Honcho fetches two tokenizer files on every start (their hashes are
checked; `check.sh` instead mounts them pre-fetched with `TIKTOKEN_CACHE_DIR`, which also works here and leaves the
model provider as the only destination); restricting it to those hosts is up to the host's firewall. Both Honcho containers run read-only, without
capabilities. Redis is not needed: Honcho's cache is off unless `CACHE_ENABLED` is set.

To run it with the rest of the stack, include the file from the compose file that runs Hermes and give Hermes the
network:

```yaml
include:
  - path: honcho/compose.yaml
services:
  hermes:
    networks: [honcho, ...]
```

## Configuration

`compose.yaml` takes four values from the environment or a `.env` file beside it (never committed):

| Variable | Value |
|---|---|
| `HONCHO_DB_PASSWORD` | `openssl rand -hex 32` (hex, since it is part of a connection URL) |
| `HONCHO_JWT_SECRET` | `openssl rand -hex 32`: signs the tokens Honcho accepts |
| `HONCHO_OPENROUTER_KEY` | Honcho's own OpenRouter key (below) |
| `HONCHO_MODEL` | The OpenRouter model id for every text feature, e.g. `<vendor>/<model>` |

### OpenRouter

Honcho's model calls go to OpenRouter, through a key used for nothing else, separate from the agent's own model
(which can stay on a [ChatGPT plan](../hermes/README.md#model-on-a-chatgpt-plan)):

- **Credit limit.** Create the key with a credit limit (<https://openrouter.ai/settings/keys>). Once it is spent,
  OpenRouter refuses the key's requests (HTTP 402, `limit_source: openrouter_key_limit`); `GET /api/v1/key` shows
  `limit_remaining` ([limits](https://openrouter.ai/docs/api-reference/limits)). It is a hard cap: a runaway loop
  spends at most the limit.
- **Zero data retention.** Enforce ZDR in the account's [privacy settings](https://openrouter.ai/settings/privacy),
  for the model groups the chosen models belong to (`openai/*` models are in the OpenAI group: ZDR removes OpenAI's
  own endpoints and keeps Azure's), and choose **ZDR only** to exclude Safety Retention endpoints
  ([ZDR](https://openrouter.ai/docs/guides/features/zdr)). The account setting covers every key of the account.
- **Chat model** (`HONCHO_MODEL`): it must support tool calling (dialectic and dreams use tools) and, for the deriver,
  structured outputs (`json_schema`); with a model that lacks them, set `DERIVER_MODEL_CONFIG__STRUCTURED_OUTPUT_MODE=json_object`.
  It must also have a ZDR endpoint without safety retention, or **ZDR only** routing leaves it unavailable and Honcho
  drops that work with only a log line. Both are public:

  ```sh
  curl -s https://openrouter.ai/api/v1/models | jq '.data[] | select(.id=="<model>") | .supported_parameters'  # tools, structured_outputs
  curl -s https://openrouter.ai/api/v1/endpoints/zdr | jq '.data[] | select(.model_id=="<model>" and (.safety_retention | not)) | .provider_name'
  ```

  Honcho's own default is `gpt-5.4-mini` (`openai/gpt-5.4-mini` on OpenRouter, ZDR through Azure on 2026-11-26).
- **Embeddings**: `openai/text-embedding-3-small`, which OpenRouter serves (`/api/v1/embeddings`, listed under
  `/api/v1/models?output_modalities=embeddings`) with a ZDR endpoint (Azure, 2026-11-26). It returns the 1536
  dimensions Honcho's schema is created with; another model means a new deployment (Honcho's
  [configuration guide](https://github.com/plastic-labs/honcho/blob/v3.6.0/docs/v3/contributing/configuration.mdx), Embedding Configuration).

Two base URLs point Honcho at OpenRouter, both in `compose.yaml`: `LLM_OPENAI_BASE_URL` for every text feature, and
`EMBEDDING_MODEL_CONFIG__OVERRIDES__BASE_URL` for embeddings, whose client reads only that one: without it,
embeddings would go to `api.openai.com` with the OpenRouter key.

### What calls the model

Read from Honcho v3.6.0's source (`src/config.py`, `src/deriver`, `src/dreamer`, `src/utils/summarizer.py`):

| Feature | When | Off |
|---|---|---|
| Deriver | Every batch of new messages: conclusions about the peers | `DERIVER_ENABLED=false`: messages are only stored and searched; no conclusions, so no dreams either |
| Summary | Every 20 messages of a session (`SUMMARY_MESSAGES_PER_SHORT_SUMMARY`) and every 60 (`..._LONG_SUMMARY`) | `SUMMARY_ENABLED=false` |
| Dream | After 50 new conclusions (`DREAM_DOCUMENT_THRESHOLD`) and 60 idle minutes (`DREAM_IDLE_TIMEOUT_MINUTES`), at most every 8 hours (`DREAM_MIN_HOURS_BETWEEN_DREAMS`) | `DREAM_ENABLED=false`; `PEER_CARD_ENABLED=false` skips only the peer-card refresh |
| Dialectic | When Hermes asks: its automatic recall (`recallMode` `hybrid` or `context`: at session start, then every `dialecticCadence` turns, 1 if unset) and its `honcho_reasoning` tool | In Hermes: `recallMode: tools` (only when the agent calls `honcho_reasoning`), or a larger `dialecticCadence` |
| Embeddings | Every stored message, every conclusion, every search | `EMBED_MESSAGES=false`: messages are not embedded and message search is full-text only |

These settings go in the `environment` of `x-honcho`, which both Honcho services share. The models per feature are set in
`compose.yaml`; a feature can have its own (for example a stronger one for `DIALECTIC_LEVELS__max__MODEL_CONFIG__MODEL`).

### Authentication

`AUTH_USE_AUTH` is on: Honcho refuses requests without a token signed with `HONCHO_JWT_SECRET`. Give Hermes a token
limited to its workspace (enough for everything Hermes does: `check.sh` uses one), with no expiry unless `--expires`
is added. Within that workspace it can read, change and delete all of the memory (the workspace itself included) and
schedule dreams, so `honcho.json` is as sensitive as a dump. Leave `WEBHOOK_SECRET` unset: without it Honcho sends no
webhooks a token could register:

```sh
docker compose exec honcho /app/.venv/bin/python scripts/generate_jwt.py --workspace hermes --print-only
```

A new secret invalidates every token issued with the old one.

## Hermes

In Hermes's `config.yaml`:

```yaml
memory:
  provider: honcho
```

and in its data volume, `honcho.json` (mode 0600) from [`honcho.example.json`](honcho.example.json), with the token
as `apiKey`:

- `baseUrl`, `workspace`: the API on the `honcho` network, and the workspace the token is limited to.
- `peerName`, `pinUserPeer: true`: one person talks to Hermes, so their messages from every platform go to one peer.
- `sessionStrategy: per-session`: a Honcho session per Hermes session (gateway chats keep one per chat).
  `honcho_search` reads every session of the workspace.
- `recallMode: hybrid`: recalled context in the prompt before each turn, plus the five `honcho_*` tools.
- `timeout`: seconds per Honcho call. A turn makes several calls, so a server that hangs instead of refusing can hold
  a turn for more than one timeout (17 s with `timeout: 10` in a test with the server paused).

What Hermes sends to Honcho, read from the pinned provider (`plugins/memory/honcho/__init__.py`):

- after every completed turn, in the background: the user's message and Hermes's final reply. Tool results go only
  as far as the reply quotes them, but a reply can quote the archive, mail or calendar;
- before a turn in `hybrid` or `context` mode: the user's message, as the recall query;
- the facts the agent saves about the user with its built-in memory tool, as conclusions; and, the first time a
  session is created with a strategy other than `per-session`, the local `MEMORY.md`, `USER.md` and `SOUL.md`.

Scheduled jobs (cron) skip Honcho entirely. Honcho passes what it stores to the model for the features above.

Recall degrades without breaking replies: Hermes starts the session with Honcho in the background, and writes and
recall failures are logged, not raised. With Honcho stopped, a turn completes (`check.sh`, in about 7 s), without
memory. Messages Honcho did not receive stay marked unsent and go with the session's next successful write, or when
the session ends; they are lost only if Hermes stops first.

## Backup

All of Honcho's data is in its Postgres database. A plain dump, while it runs:

```sh
docker compose exec -T honcho-db pg_dump -U honcho -d honcho > honcho.sql
```

Restore into an empty database, Honcho stopped:

```sh
docker compose rm -sf honcho honcho-deriver honcho-db
docker volume rm <project>_honcho-db
docker compose up -d --wait honcho-db
docker compose exec -T honcho-db psql -X -q -v ON_ERROR_STOP=1 -U honcho -d honcho < honcho.sql
docker compose up -d
```

`check.sh` runs exactly this between the two sessions, so the recall it checks comes from the restored database.
The dump holds every stored message: keep it as private as the archive. Honcho's tokens survive a restore as long
as `HONCHO_JWT_SECRET` is kept with it.

## Upgrades

Renovate proposes new server releases (`compose.yaml`); CI's `check.sh` must pass before one merges. The provider in
the Hermes image is pinned separately ([`hermes/Dockerfile`](../hermes/Dockerfile)) and moves by hand. Honcho applies
its migrations at start: take a dump first.
