# Instructions for Copilot code review

alfred is the backend of a private assistant: `ingest` archives a WhatsApp account into Postgres through Baileys, `api` serves that archive plus notes and reminders over HTTP to an agent, `transcriber` is a Python speech-to-text service, and `db` holds the shared Postgres client and the migrations. The README of each folder describes the service.

## What matters most

- **ingest only reads.** It is a passive linked device: it must never send messages, reactions, read receipts, presence or anything else to WhatsApp. Flag any change that could.
- **Credentials stay out of reach.** `wa_auth` holds the WhatsApp session. The `archive_reader` and `api_access` roles must never get access to it, and the API must not need more than `api_access` (read on the archive, write on notes and reminders).
- **Migrations are append-only.** `db/migrations/NNN_*.sql` are applied in order at ingest startup, each in its own transaction, and recorded by file name. An applied migration is never edited or renamed: a change is a new file with the next number. Check that new tables and columns get the grants the roles need, and that a migration also works on a database that already holds data.
- **SQL is parameterized.** Queries use the `postgres` tagged template (`sql\`…\``), with fragments composed as values. Flag user input reaching `sql.unsafe` or string-built SQL.
- **Every API endpoint except `/health` requires the bearer token.**

## API conventions

- Bad input is a `400` through `HttpError` with a message that names the parameter. An empty query parameter counts as absent (`param()`), because agent tools send every parameter, filled or not.
- Limits have a default and a maximum (`intParam`).
- Dates without an offset are in `TZ`. Pass them to Postgres as text (`::text::timestamp AT TIME ZONE tz`), not as a JS `Date`, which is read in the process's zone. A bare date as an upper bound includes that day.
- Reminders keep their wall-clock time across daylight saving changes. Claiming due reminders must stay safe under concurrent calls.
- The endpoint and variable tables in the READMEs are the documentation. A change to an endpoint, parameter or environment variable must update them in the same pull request.

## Code style

- TypeScript in strict mode, ES modules (`nodenext`, imports end in `.js`), Node 24, npm workspaces. `npm run build` and `npm run typecheck` must pass.
- Comments are short and say why, not what. Match the density and tone of the surrounding code.
- Small, direct code over new abstractions or dependencies. There is no linter or formatter: don't comment on formatting.
- Commit subjects follow Conventional Commits with the service as scope: `feat(api): …`, `fix(ingest): …`.

## CI and dependencies

- GitHub Actions are pinned by commit digest with the version in a comment. Keep it that way.
- CI builds, then runs `smoke/run.sh`: the ingest image up to WhatsApp's pairing QR, and the API's reads and writes against a fresh Postgres.
- Renovate opens and merges most dependency updates. On those pull requests, look at breaking changes in the changelog, especially for `baileys`, `postgres` and the base images, rather than at the diff itself.
- The transcriber runs on an Intel GPU that CI doesn't have, and its image is amd64 only (OpenVINO has no ARM wheels). Point out changes there that can't be verified by CI.
