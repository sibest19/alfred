# Alfred MCP adapter

Stateless Streamable HTTP MCP at `POST /mcp`, using the official TypeScript SDK.

To let other clients send requests **to Alfred**, run the separate
[inbox entrypoint](#incoming-requests-to-alfred). The default entrypoint below
offers backend tools for Alfred to call.
Read-only tools: `whatsapp_search`, `whatsapp_context`, `whatsapp_stats`,
`whatsapp_find_chat`, `whatsapp_find_contact` (scope `archive.read`), `mail_search`,
`mail_read` (iCloud Mail and Gmail accounts, `mail.read`), `calendar_events` (iCloud's and
Radicale's calendars, `calendar.read`) and `reminders_list` (Radicale's to-dos, `todos.read`).
Write tools: `event_create`, `event_update`, `event_delete` (`calendar.create`, `.update`,
`.delete`) and `reminder_create`, `reminder_update`, `reminder_complete`, `reminder_delete`
(`todos.manage`). All call fixed routes on Alfred's API; its credential needs the
scopes of the tools the client should be able to use, and a missing scope is a 403
the tool reports. No SQL access, generic URLs or filesystem tools.
For scheduled runs that report what is new, `whatsapp_search` takes the API's poller
cursor `after_id` (messages archived after the highest id a previous search returned) and
`mail_search` a `from` date.

## Credentials and configuration

Variables are listed in `env.example`. Keep real secrets outside Git:

- `ALFRED_API_URL`: trusted API origin, default `http://alfred-api:8080`. No path,
  credentials, query or fragment. Redirects are refused.
- `ALFRED_API_TOKEN`: dedicated scoped credential with only the scopes of the
  tools to offer (`archive.read`; `mail.read`; `calendar.read` and the calendar write
  scopes; `todos.read`, `todos.manage`), never the legacy full-access `API_TOKEN`.
- `MCP_TOKEN`: a different secret presented by Hermes. Inbound credentials are
  never forwarded to Alfred. Both secrets need at least 16 bytes, no whitespace.
- `MCP_ALLOWED_HOSTS`: explicit hostnames without ports; defaults to
  `alfred-mcp,localhost,127.0.0.1,[::1]`. Browser Origins are rejected.
- `MCP_RATE_LIMIT`: authenticated requests per 60-second window, default 60.
- `MCP_MAX_CONCURRENT`: in-flight requests and upstream reads, default 4. Both
  limits are per adapter process; overload returns 429 with `Retry-After`.
- `HTTP_PORT`: default 8080. The container binds all interfaces; attach only
  dedicated internal links, without publishing a host port.

Hermes configuration for the eventual pilot (not deployed):

```yaml
mcp_servers:
  whatsapp:
    url: http://alfred-mcp:8080/mcp
    headers:
      Authorization: "Bearer ${ALFRED_MCP_TOKEN}"
```

`ALFRED_MCP_TOKEN` in Hermes is the adapter's `MCP_TOKEN`, not its API credential.
Filter tools to the WhatsApp specialist as well as enforcing API scopes. Verify
the selected Hermes release against this endpoint before switching the real bot.
The tests exercise the 2025-06-18 initialize/list/call flow and 2026-07-28
discovery, header validation and stateless error behavior. Legacy HTTP+SSE and
sessionful GET/DELETE transports are not provided.

Input schemas reject unknown fields and bound search/context sizes. Upstream
requests time out after 15 seconds; replies are capped at 256 KiB and MCP request
bodies at 16 KiB. Failures become tool errors without raw upstream error text or
retrying. Archived messages remain untrusted reference data. `GET /health` reports
adapter availability, not API/database readiness.

## Build and verification

From the repository root: `pnpm build && pnpm typecheck && pnpm test`.
Build with `docker build -f mcp/Dockerfile -t alfred-mcp:smoke .`.
`smoke/run.sh` exercises MCP against a scoped API and fresh Postgres. The MCP
container runs as UID 1000, read-only, without capabilities or host mounts, and
joins only the internal API link. Host UID/ACL provisioning and host/LAN egress
restrictions remain a separate deployment increment.

There is no persistent adapter state. Add tools through explicit schemas and
fixed-route handlers in `src/tools.ts`, preserving API permission checks and
adding allowed/denied tests. Annotations (read-only, destructive) do not replace
authorization; a write tool's id is 8 hex characters from a listing, so no path can
be injected.

Protocol serving uses the [official SDK HTTP handler](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md),
with per-request server instances, bearer authentication and Host/Origin guards.

Known [MCP gaps and deployment gates](GAPS.md) are tracked explicitly. A repeatable
[isolated Hermes trial](../smoke/hermes/README.md) exercises this adapter with
synthetic data and Hermes's own discovery/dispatch and agent loop. The optional
real-model mode uses a bounded relay with a separate test key.

## Incoming requests to Alfred

The same image can run `node dist/inbox-main.js` in a separate container. It
exposes only `send_to_alfred(request, content, origin?)` at `POST /mcp`, never
the archive tools. `request` and `content` are required, with limits of
4000 and 24000 characters; optional `origin` is at most 1000 characters.
Origin is caller-provided reference data, never an identity or permission.

Configure these secrets outside Git:

| Variable | Purpose |
| --- | --- |
| `HERMES_API_URL` | Fixed Hermes origin, default `http://hermes:8642` |
| `HERMES_API_KEY` | Dedicated Hermes API credential, distinct from `MCP_TOKEN` |
| `MCP_TOKEN` | Credential presented by incoming MCP clients |
| `TELEGRAM_BOT_TOKEN` | Bot credential used to deliver Alfred's final reply |
| `TELEGRAM_CHAT_ID` | Fixed owner's private chat, a positive numeric ID |

`HTTP_PORT`, `MCP_ALLOWED_HOSTS`, `MCP_RATE_LIMIT` and `MCP_MAX_CONCURRENT`
work as above; inbox defaults are six authenticated requests/minute and one
in flight. Its JSON body limit is 192 KiB so maximum-size escaped input fits.
Keep ingress authenticated and TLS-terminated; this bearer-only service does
not implement OAuth. Give it only the Hermes API link and required Telegram
egress, with no API/database credentials or host mounts.

Enable Hermes's API server with a private listener (`API_SERVER_ENABLED=true`,
`API_SERVER_KEY`, `API_SERVER_HOST=0.0.0.0` inside its container). Explicitly set
`platform_toolsets.api_server` to Alfred's permitted tools before enabling it;
an authenticated MCP caller can cause those tools to run. Do not expose the
Hermes API itself to clients. The bridge sends one non-streaming completion,
with a fixed MCP session key for memory scoping, and no conversation history
copied from Telegram. Reference content is separated from the request in the
prompt. The server creates the ingress context; caller text cannot select a
destination, model, URL, session or toolset.

A complete response is sent as plain text to the fixed Telegram chat, split
without breaking Unicode characters, then returned as `{status: "processed",
reply}`. This status confirms a reply, not a saved note or successful action.
Hermes calls time out after 180 seconds; Telegram calls after 15 seconds, with
30 seconds total for all delivery chunks.
Both replies are limited to 256 KiB; agent text is limited to 24000 UTF-16 units.
No calls are automatically retried. Partial/failed/uncertain agent outcomes
are tool errors with `status: "unknown"`. If Alfred replies but Telegram delivery
fails, the tool error retains `status: "processed"`, the reply and
`telegram_delivery: "unknown"`. Check with Alfred before retrying: the agent's
actions or some Telegram chunks may already have completed. A disconnected MCP
client does not cancel or roll back Hermes's actions.

Migration: move clients to this endpoint and its new dedicated credential;
verify initialize/list/call and Telegram delivery, then revoke the old n8n
bearer credential and remove the retired MCP workflow and routing. Keep that
credential revoked in backups/restores; rollback must use the current bridge
and credentials rather than reactivating the old workflow. No n8n forwarding
fallback is provided. Unit tests use synthetic Hermes/Telegram replies only.
