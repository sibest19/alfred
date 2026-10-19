# wa-ingest

Archives a WhatsApp account into Postgres. It links as a WhatsApp device (like WhatsApp Desktop) through [Baileys](https://github.com/WhiskeySockets/Baileys) and writes every message, edit, deletion, reaction, chat, contact and group to the database, plus the media files to disk. It only reads: nothing is ever sent.

It is the ingestion half of a private assistant; whatever answers questions (n8n, an agent) reads the database.

> Baileys is an unofficial client. WhatsApp can ban numbers that use it, although a passive, read-only linked device is the low-risk case.

## Running

```sh
docker run -e PGHOST=… -e PGUSER=… -e PGPASSWORD=… -e PGDATABASE=… \
  -v /path/to/media:/media ghcr.io/sibest19/wa-ingest:<version>
```

On first start it prints a QR code in the log: on the phone, *WhatsApp → Linked devices → Link a device*. Or set `WA_PAIRING_PHONE` (your number with country code, digits only) and enter the 8-character code it logs under *Link with phone number instead*. The phone then pushes the history; progress shows as `history chunk` log lines.

The link survives restarts (the credentials are in the `wa_auth` table). If the device is removed from the phone, the service clears `wa_auth` and restarts into a new QR.

| Variable | Default | |
|---|---|---|
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | | Postgres connection. The schema is created and migrated at startup |
| `MEDIA_DIR` | `/media` | Where media files go: `<yyyy>/<mm>/<message id>.<ext>` |
| `MEDIA_HISTORY_DAYS` | `90` | Media from history sync older than this is recorded but not downloaded (`0`: none) |
| `MEDIA_MAX_MB` | `100` | Larger files are recorded but not downloaded |
| `MEDIA_CONCURRENCY` | `2` | Parallel downloads |
| `MEDIA_MAX_ATTEMPTS` | `8` | Retries (exponential backoff, up to 6 h) before a download is `failed` |
| `WA_PAIRING_PHONE` | | Pair with a code instead of the QR |
| `WA_BROWSER` | `ubuntu:Desktop` | Linked-device identity `<os>:<browser>`. `Desktop` asks for the full history; if the phone refuses to link, try `macOS:Chrome` (less history) |
| `TRANSCRIBER_URL` | | Speech-to-text service (see below): downloaded audio is transcribed into `messages.body` and `media.transcript` |
| `HTTP_PORT` | `8080` | `/health` and `/metrics` |
| `LOG_LEVEL` / `BAILEYS_LOG_LEVEL` | `info` / `warn` | |

## Endpoints

- `GET /health`: `200` only while connected to WhatsApp, else `503` with `{"connection": "waiting_for_pairing" | "closed" | …}`. A dead session is the failure that matters, so it makes the container unhealthy.
- `GET /metrics`: Prometheus. `wa_connected`, `wa_connection_closes_total{code}`, `wa_messages_ingested_total{source}`, `wa_decrypt_failures_total`, `wa_last_live_message_timestamp_seconds`, `wa_history_chunks_total`, `wa_media_downloads_total{result}`, `wa_media_queue{status}`, plus Node.js process metrics.

Alert on `wa_connected == 0` and on `wa_decrypt_failures_total` rising: a session whose Signal keys broke stays connected but can't decrypt anything.

## Database

See [`migrations/001_init.sql`](migrations/001_init.sql). The main tables:

- `messages`: one row per message, unique on the WhatsApp message id. `body` is the text or caption (a short description for contacts, locations and polls), `type` the Baileys content type, `quoted_msg_id` the replied-to message, `raw` the full message as JSON. `search` is a full-text index (`to_tsvector('simple', body)`).
- `message_revisions`: every edit and deletion (`deleted_at` on the message; the body is kept).
- `reactions`, `media` (download status, `path` relative to `MEDIA_DIR`, `sha256`), `chats`, `contacts`, `group_participants`, `lid_map`.
- `messages_view`: messages with readable `chat_name` and `sender_name`.

WhatsApp identifies people either by phone (`…@s.whatsapp.net`) or by a privacy id (`…@lid`). `chat_jid` and `sender_jid` use the phone form whenever the mapping is known; `lid_map` keeps every mapping seen.

What it can't get: edits and deletions from before the link (WhatsApp keeps no history of them), and old media the phone no longer has. How much history arrives on the first link is decided by the phone.

```sql
-- last week's messages mentioning "cena"
SELECT sent_at, chat_name, sender_name, body FROM messages_view
WHERE search @@ websearch_to_tsquery('simple', 'cena') AND sent_at > now() - interval '7 days'
ORDER BY sent_at;
```

## Transcriber

`transcriber/` is a small speech-to-text service, published as `ghcr.io/sibest19/wa-ingest-transcriber:<version>` (amd64). It runs [Parakeet Ultra](https://huggingface.co/moondream/parakeet-ultra) (NVIDIA Parakeet TDT 0.6B v3 post-trained by Moondream; 25 European languages, punctuation, CC BY 4.0) as ONNX through [onnx-asr](https://github.com/istupakov/onnx-asr), on an Intel GPU via ONNX Runtime's OpenVINO provider (`DEVICE=GPU`, needs `/dev/dri/renderD*` and the render group) or on the CPU (`DEVICE=CPU`). The model (`MODEL_REPO`, default `Masterx/parakeet-tdt-0.6b-ultra-onnx`, `MODEL_QUANTIZATION=fp16`) is downloaded into `/models` on first start. GPU kernels are compiled at every start (about 30 s): OpenVINO's on-disk cache (`OPENVINO_CACHE_DIR`) is off by default, because a cached model aborted the process at its first inference on an Arc A310.

- `POST /transcribe`: audio in any format ffmpeg reads (raw body or multipart `file`) → `{"text", "duration_s", "elapsed_s"}`.
- `POST /v1/audio/transcriptions`: the OpenAI-style form of the same.
- `GET /health`: `200` once the model is loaded and warmed up.

Measured on an Intel Arc A310 (fp16): a 197 s voice note in 10 s, a 4 s one in 0.15 s; the same on a Ryzen 9 5900X CPU took 18 s and 0.25 s.

## Development

Node 24, TypeScript. `npm ci && npm run build`, then `node dist/index.js` with the `PG*` variables set. Pushing a `v*` tag publishes `ghcr.io/sibest19/wa-ingest:<version>` (amd64 and arm64).
