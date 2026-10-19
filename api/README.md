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
| `GET /notes` | `q` (words, a name, a tag or a topic), `tag`, `kind`, `topic` (that topic and everything under it), `archived=true` (also deleted and merged notes, with `merged_into`), `limit` (20, max 500); summaries first, no `q` = latest |
| `POST /notes` | JSON `title`, `content`, `kind` (`note`, `fact`, `preference`, `idea`, `link`, `todo`), `tags` (array or comma-separated), `topic`, `source` (`user` \| `assistant`) |
| `PATCH /notes/<id>` | the fields to change; empty ones are kept, tags are replaced |
| `DELETE /notes/<id>` | soft delete (`deleted_at`) |
| `POST /notes/<id>/restore` | brings back a deleted or merged note; one taken out of a merge shows that note as `kept_apart_from` |
| `POST /notes/merge` | JSON `ids` and either `into` (an existing note, updated with the fields given) or the fields of a new note; the `ids` are archived with `merged_into` |
| `GET /notes/topics` | the topic index: each topic with its note count and the start of its summary, and `text`, the same as lines for a prompt |
| `PUT /notes/summaries` | JSON `topic`, `content` (`title`, `tags`): creates or replaces the topic's summary note |
| `GET /consolidations/pending` | notes created, changed or deleted since the last recorded consolidation |
| `POST /consolidations` | JSON `started_at`, `changes`, `report`: records a consolidation run |
| `POST /transcribe` | audio body, passed to `TRANSCRIBER_URL` |
| `GET /health` | `200` while the database answers |

Stubs (group events) and undecryptable messages are left out of the message endpoints.

Topics are paths of 1-4 lowercase words (`people/giulia`, `places/restaurants/bergamo`); accents and spaces are folded, and the first word must be one of `NOTE_TOPIC_ROOTS`. A topic has at most one summary (kind `summary`), written with `PUT /notes/summaries`. A consolidation job (an agent run on a schedule) is expected to file notes under topics, merge duplicates and keep the summaries current, and to record each run so the next one only starts when notes changed.

| Variable | Default | |
|---|---|---|
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | | Postgres, as the login above |
| `API_TOKEN` | | Bearer token, 16 characters or more (required) |
| `TZ` | `UTC` | Time zone for dates in and out |
| `TRANSCRIBER_URL` | | Speech-to-text service behind `POST /transcribe` |
| `NOTE_TOPIC_ROOTS` | `people,places,preferences,home,work,health,projects,ideas,reading,travel,other` | Allowed first level of a note's topic |
| `HTTP_PORT` | `8080` | |
| `LOG_LEVEL` | `info` | |
