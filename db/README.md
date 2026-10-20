# db

The Postgres client shared by the services (`@alfred/db`, configured by the standard `PG*` variables) and the schema migrations, applied in order by the ingester at startup under an advisory lock.


Schema in [`migrations/`](migrations). The main tables:

- `messages`: one row per message, unique on the WhatsApp message id. `body` is the text or caption (a short description for contacts, locations and polls), `type` the Baileys content type, `quoted_msg_id` the replied-to message, `raw` the full message as JSON. `search` is a full-text index (`to_tsvector('simple', body)`).
- `message_revisions`: every edit and deletion (`deleted_at` on the message; the body is kept).
- `reactions`, `media` (download status, `path` relative to `MEDIA_DIR`, `sha256`), `chats`, `contacts`, `group_participants`, `lid_map`.
- `messages_view`: messages with readable `chat_name` and `sender_name`.
- `notes`: what an assistant was asked to remember or chose to, under a `topic` path, with one `summary` note per topic and `merged_into` for merged notes (see [`../api`](../api)); `consolidations` records each consolidation run.
- `reminders`: an assistant's alarms (`pending` → `fired` → `done`, or `cancelled`). A repeating reminder is one row per occurrence, linked by `series_id`; the repeat (`repeat_unit`, `repeat_every`, `repeat_days`, `repeat_until`, `repeat_anchor` in local wall-clock time) lives on the newest one, and `reminder_next()` computes the next occurrence in the API's time zone.

WhatsApp identifies people either by phone (`…@s.whatsapp.net`) or by a privacy id (`…@lid`). `chat_jid` and `sender_jid` use the phone form whenever the mapping is known; `lid_map` keeps every mapping seen.

What it can't get: edits and deletions from before the link (WhatsApp keeps no history of them), and old media the phone no longer has. How much history arrives on the first link is decided by the phone.

```sql
-- last week's messages mentioning "cena"
SELECT sent_at, chat_name, sender_name, body FROM messages_view
WHERE search @@ websearch_to_tsquery('simple', 'cena') AND sent_at > now() - interval '7 days'
ORDER BY sent_at;
```

Roles: `archive_reader` (SELECT on everything except `wa_auth`) for direct read-only logins, `api_access` (archive_reader plus writing notes and reminders) for the API's login.
