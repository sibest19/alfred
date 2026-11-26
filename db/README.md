# db

The Postgres client shared by the services (`@alfred/db`, configured by the standard `PG*` variables) and the schema migrations, applied in order by the ingester at startup under an advisory lock.


Schema in [`migrations/`](migrations). The main tables:

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

Roles: `archive_reader` (SELECT on everything except `wa_auth`) for direct read-only logins, `api_access` (archive_reader; created by `003`) for the API's login.

## Retired tables (migration 008)

Migrations `003`-`007` created `notes`, `consolidations`, `reminders` and `reminder_next()` for a retired n8n agent; `008` drops them. Deploy an `api` release that no longer has the notes and reminders routes first, then the `ingest` release carrying `008`: an older API answers `500` on those routes once the tables are gone.

`008` refuses, and ingest stops at startup with `migration 008 refuses to drop reminders`, while a reminder is still `pending`: export those (`SELECT * FROM reminders WHERE status = 'pending'`), move them elsewhere, cancel them (`UPDATE reminders SET status = 'cancelled' WHERE status = 'pending'`) and restart ingest. Everything else in the three tables is dropped, so export notes too if they are still wanted. Restoring a backup taken before `008` brings the tables back until ingest applies `008` again at its next start, with the same check. Rolling `api` back to a release with those routes would need the retired `API_TOKEN` again: roll forward instead.
