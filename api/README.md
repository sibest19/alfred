# api

Serves the archive over HTTP, for an agent that shouldn't hold database credentials, and the user's iCloud Mail and Calendar, Gmail accounts and a Radicale (CalDAV) server's calendars and to-do lists. It reads the archive and the mail, and writes only calendar events and to-dos; it runs apart from the ingester, so a restart never touches the WhatsApp session. Image `ghcr.io/sibest19/alfred-api:<version>`. Every request except `/health` needs a scoped bearer credential. Dates without an offset are read and shown in `TZ`.

## Scoped credentials

`API_SCOPED_TOKENS` (required) is a JSON object of named credentials, the API's only credentials, for example:

```json
{"hermes":{"token":"replace-with-a-unique-random-secret","scopes":["archive.read"]}}
```

Generate a distinct random secret for every caller, store it outside Git, and send
it as `Authorization: Bearer <token>`. Names are configuration labels, not secrets
or permissions; each request's log line names its caller (`caller`), so the log
shows which credential made every write. A missing or empty variable, invalid or
duplicate tokens and unknown scopes prevent startup; missing/wrong credentials
return `401`, insufficient scope returns `403` before the handler runs, and an
unknown route `404`.

| Scope | Operations |
|---|---|
| `archive.read` | GET messages, message context, stats, chats and contacts |
| `mail.read` | Search/read iCloud and Gmail mail |
| `calendar.read` | List calendar events |
| `calendar.create`, `calendar.update`, `calendar.delete` | The corresponding calendar write |
| `todos.read` | List Radicale to-dos |
| `todos.manage` | Create, change, complete and delete Radicale to-dos |

Every registered API route must declare a scope. These are operation permissions,
not per-chat/account restrictions or user approvals. Give each caller only the
scopes of the tools it offers (the MCP adapter's are in [`../mcp`](../mcp)).

The notes, consolidations, reminders (`/notes`, `/consolidations`, `/reminders`),
speech-to-text (`POST /transcribe`) and model proxy (`/openrouter/v1/`) routes, their
scopes and the full-access `API_TOKEN` served a retired n8n agent and are gone: those
routes answer `404`, a credential naming one of their scopes prevents startup, and
`API_TOKEN` is not read (remove it from the deployment). Deploy this release before
the `ingest` release whose migration `008` drops their tables (see [`../db`](../db)).

Give it its own login with the `api_access` role (created by the migrations: read on the archive, nothing on `wa_auth`):

```sql
CREATE ROLE assistant_api LOGIN PASSWORD '…' IN ROLE api_access;
ALTER ROLE assistant_api SET statement_timeout = '15s';
```

| Endpoint | |
|---|---|
| `GET /messages` | `q` (words, prefix match; `match=any` for OR), `chat` and `sender` (name or JID; `sender=me`), `kind` (`text`, `image`, `video`, `audio`, `document`, `sticker`, `other`), `from`/`to` (`2026-10-01` or `2026-10-01 18:30`; a bare `to` date includes that day), `order` (`desc`), `limit` (30, max 100); `after_id` (for a poller: only messages archived after that id, in archive order, so a late arrival is still new) |
| `GET /messages/<id>/context` | the conversation around a message: `before`, `after` (10 each, max 50) |
| `GET /stats` | message counts with the `/messages` filters, `group_by` `chat` \| `sender` \| `day` \| `month` \| `kind`: the 100 biggest groups, or the latest 100 days or months; `total` counts them all |
| `GET /chats` | chats by name (`q`), most recent first |
| `GET /contacts` | contacts by name or number (`q`), with their phone number |
| `GET /mail` | Mail, newest first: `account` (`icloud` by default, or a name from `GMAIL_ACCOUNTS`), `q` (words in the headers and body; Gmail search syntax for a Gmail account), `sender`, `subject`, `unread=true`, `from`/`to` (as for `/messages`), `mailbox` (iCloud `INBOX` or Gmail's All Mail by default, which must be shown in IMAP; a wrong name lists the others), `limit` (20, max 50); each with an `id` like `INBOX:4521` (Gmail: `<account>#<message id>`, the same in every label) and a snippet |
| `GET /mail/read` | `ids` (up to 10, comma-separated): the messages in full (body text, recipients, attachment names). Mailboxes are opened read only: nothing is marked as seen |
| `GET /calendar/events` | Events of a period in iCloud's and Radicale's calendars (one list of names; with a server down, the others' events and a note that names may change when it is back; creating an event needs every server), repeating ones expanded into occurrences: `from` (today), `to` (a week later; a bare date includes that day; at most 366 days), `q` (words in the title, place or notes), `calendar` (a name); with the calendars' names |
| `POST /calendar/events` | JSON `title`, `start` (`2026-11-03 18:00`, or a date for an all-day event), `end` (an hour later; for an all-day event its last day), `all_day`, `location`, `notes`, `calendar` (`ICLOUD_CALENDAR`, else the first) |
| `PATCH /calendar/events/<id>` | the fields to change (empty ones are kept; `-` removes a `location` or `notes`); a new `start` keeps the length. On a repeating event `occurrence` (a date) names the one meant: only that one changes, or with `series=true` all of them, a new start moving every occurrence by as much |
| `DELETE /calendar/events/<id>` | deletes the event, a whole series; `occurrence` (a date) deletes that occurrence only |
| `GET /todos` | Radicale's open to-dos (`done=true`: the completed ones too), by due time: `q` (words in the title or notes), `list` (a name); with the lists' names |
| `POST /todos` | JSON `title`, `due` (`2026-11-13 15:00`, a bare date means 09:00, not in the past; without it no date and no alarm), `notes`, `repeat` (an iCalendar RRULE such as `FREQ=WEEKLY;BYDAY=MO`; needs a due time), `list` (the first by default) |
| `PATCH /todos/<id>` | `title`, `due`, `notes`, `repeat` to change (empty ones are kept; `-` removes a due time, notes or repeat); a new due time reopens a completed to-do |
| `POST /todos/<id>/done` | completes it; a repeating one moves on to the first occurrence due after now and after the current one, and stays open |
| `DELETE /todos/<id>` | deletes it, a repeating one with every occurrence |
| `GET /health` | `200` while the database answers |

Stubs (group events) and undecryptable messages are left out of the message endpoints.

The mail and calendar answers carry `text`, the same as lines for a prompt (an agent's tool can pass on that alone), and errors say what to change. Mail ids stay valid: iCloud ids are per mailbox (`<mailbox>:<uid>`; an id with a colon always means iCloud), Gmail ids per account (`<account>#<message id>`, found in All Mail, Spam or Trash); calendar event ids are 8 characters and known from a listing or a write since the API started, so after a restart an id asks for the events to be listed again. iCloud takes an [app-specific password](https://support.apple.com/102654), which serves both IMAP and CalDAV; without it and without Radicale the calendar routes answer `503`, without it the iCloud mail routes do.

To-dos are written the way an iPhone's Reminders app rings for them: `DTSTART` and `DUE` with `TZID` set to `TZ`, and an alarm (`ACTION:DISPLAY`, `TRIGGER:PT0S`) at that moment. A new due time moves `DTSTART` along at the same distance and the item's alarms with it (one is added when it has none); a new title only renames it and its alarms' text. Completing a repeating to-do moves `DTSTART` and `DUE` to the next occurrence in their own zone; repeats go from `DAILY` to `YEARLY`. Phones fetch CalDAV changes on their own schedule, so a to-do due within minutes may ring late. Every write sends the item's ETag (`If-Match`, `If-None-Match: *` to create), so a change made on a phone meanwhile answers `409` instead of being overwritten. Radicale is reached with `RADICALE_USER` on the collections under `RADICALE_HOME`, which may be another user's that it is allowed to act on; the API never creates, renames or deletes a collection. Without discovery, since Radicale checks the password (bcrypt) on every request: the collections are listed once every ten minutes.

| Variable | Default | |
|---|---|---|
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | | Postgres, as the login above |
| `API_SCOPED_TOKENS` | | Named token/scope credentials as JSON, at least one (each token at least 16 bytes, no whitespace; required) |
| `TZ` | `UTC` | Time zone for dates in and out |
| `ICLOUD_USER`, `ICLOUD_PASSWORD` | | iCloud Mail and Calendar: the Apple ID and an app-specific password; empty disables them |
| `GMAIL_ACCOUNTS` | `{}` | Gmail accounts read over IMAP, as JSON: `{"<name>": {"user": "<address>", "password": "<app password>"}}`; names are lowercase letters, digits and `-`. Each account needs 2-Step Verification and an [app password](https://support.google.com/accounts/answer/185833) |
| `ICLOUD_CALENDAR` | | Calendar for new events when the request names none (default: the first) |
| `RADICALE_URL` | | A Radicale server, e.g. `http://radicale:5232`; empty disables it |
| `RADICALE_USER`, `RADICALE_PASSWORD` | | Its login |
| `RADICALE_HOME` | `/<RADICALE_USER>/` | The collections used: calendars (VEVENT) join iCloud's, to-do lists (VTODO) serve `/todos` |
| `HTTP_PORT` | `8080` | |
| `LOG_LEVEL` | `info` | |
