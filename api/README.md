# api

Serves the archive and a notes table over HTTP, for an agent that shouldn't hold database credentials. It reads the archive and writes only notes; it runs apart from the ingester, so a restart never touches the WhatsApp session. Image `ghcr.io/sibest19/alfred-api:<version>`. Every request except `/health` needs `Authorization: Bearer <API_TOKEN>`. Dates without an offset are read and shown in `TZ`.

Give it its own login with the `api_access` role (created by the migrations: read on the archive, write on notes, nothing on `wa_auth`):

```sql
CREATE ROLE assistant_api LOGIN PASSWORD '…' IN ROLE api_access;
ALTER ROLE assistant_api SET statement_timeout = '15s';
```

| Endpoint | |
|---|---|
| `GET /messages` | `q` (words, prefix match; `match=any` for OR), `chat` and `sender` (name or JID; `sender=me`), `kind` (`text`, `image`, `video`, `audio`, `document`, `sticker`, `other`), `from`/`to` (`2026-10-01` or `2026-10-01 18:30`; a bare `to` date includes that day), `order` (`desc`), `limit` (30, max 100) |
| `GET /messages/<id>/context` | the conversation around a message: `before`, `after` (10 each, max 50) |
| `GET /stats` | message counts with the `/messages` filters, `group_by` `chat` \| `sender` \| `day` \| `month` \| `kind` |
| `GET /chats` | chats by name (`q`), most recent first |
| `GET /contacts` | contacts by name or number (`q`), with their phone number |
| `GET /notes` | `q` (words, a name or a tag), `tag`, `kind`, `limit`; no `q` = latest |
| `POST /notes` | JSON `title`, `content`, `kind` (`note`, `fact`, `preference`, `idea`, `link`, `todo`), `tags` (array or comma-separated), `source` (`user` \| `assistant`) |
| `PATCH /notes/<id>` | the fields to change; empty ones are kept, tags are replaced |
| `DELETE /notes/<id>` | soft delete (`deleted_at`) |
| `POST /transcribe` | audio body, passed to `TRANSCRIBER_URL` |
| `GET /health` | `200` while the database answers |

Stubs (group events) and undecryptable messages are left out of the message endpoints.

| Variable | Default | |
|---|---|---|
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | | Postgres, as the login above |
| `API_TOKEN` | | Bearer token, 16 characters or more (required) |
| `TZ` | `UTC` | Time zone for dates in and out |
| `TRANSCRIBER_URL` | | Speech-to-text service behind `POST /transcribe` |
| `HTTP_PORT` | `8080` | |
| `LOG_LEVEL` | `info` | |
