# Hermes

Alfred's agent: [Hermes Agent](https://github.com/NousResearch/hermes-agent), pinned by digest, with the Honcho memory
provider and two changes made here (see [`Dockerfile`](Dockerfile)): it starts the CLI directly, so it runs
as any UID on a read-only root with `HERMES_HOME` (`/opt/data`) as its only writable mount, and it never copies files
back from a remote terminal backend ([sandbox](../sandbox/README.md)). Run it with an init process. [`check.sh`](check.sh)
checks the built image offline.

Its tools are the [MCP adapter](../mcp/README.md) and, when configured, the [sandbox](../sandbox/README.md).

## Model on a ChatGPT plan

Instead of a pay-per-token API key, the model can run on a ChatGPT plan through Hermes's `openai-codex` provider. The
login is a device code, so it works inside the container:

```sh
docker compose exec hermes hermes auth add openai-codex   # open the printed URL, enter the code
docker compose exec hermes hermes model                   # ChatGPT or Codex Subscription, then the model
```

The credentials stay in Hermes's own `auth.json` in its data volume. In `config.yaml`:

```yaml
auth:
  adopt_external_logins: false
```

Otherwise Hermes may adopt a Codex CLI login from the same home, and the two would rotate one refresh token family
until one of them is logged out. Hermes's auxiliary tasks (smart approvals, memory review, compression) use the main
model unless set otherwise, so they run on the subscription too (see Limits for when they don't). `hermes dump` shows the provider in effect.

What changes with it:

- **Quota, not invoices.** The agent shares the plan's usage limits with any other Codex use of that account; when
  they run out, it stops answering until they reset. Scheduled jobs count against the same limits.
- **Data.** Messages and mail excerpts the agent reads go to OpenAI under the plan's terms, not through the
  zero-retention routing the [real-model trial](../smoke/hermes/README.md) uses. Check the account's data controls
  (model improvement off).
- If the login expires or is revoked, Hermes stops retrying the dead refresh token and asks for a new login: run the
  first command again.

Hermes does not document how its usage counts against a plan's Codex limits, nor whether a plan's terms cover an
always-on assistant: check both for the account you use.

## Limits

[`config.example.yaml`](config.example.yaml) bounds a run: no fallback provider, a single attempt per model call,
no recovery cycles after it, at most 40 turns, flagged commands decided by the owner instead of an auxiliary model,
no model call for session titles, and Hermes's own ChatGPT login only. [`check.sh`](check.sh) checks that each key
still exists in the pinned Hermes and that Hermes resolves the values the example sets.

With these settings a usage-limit reply, with or without a reset time, ends the run at once with an error: no
`Retry-After` wait, no other provider. Some connection and server errors get one more try after the client is rebuilt.
That holds only without `fallback_model` in the configuration (it adds a fallback too) and while Hermes can see no
other provider: its auxiliary tasks (compression, memory review, approvals in
`smart` mode) fall through to any other key or login in its environment or `auth.json` once the main model refuses,
and `free_only` covers only the OpenRouter step. Give Hermes no other provider credentials.

Hermes still has no hard wall-clock limit on a run (`mcp/GAPS.md`, HERMES-01): `run_budget_seconds` mainly asks the
model to wrap up. In a chat, `manual` approvals hold a run on each flagged command until the owner answers or
`approvals.timeout` (300 s by default) denies it; scheduled, API-server and webhook runs deny flagged commands
whatever the mode (`cron_mode`, `unattended_mode`).
