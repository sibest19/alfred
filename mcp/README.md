# WhatsApp MCP adapter

Stateless Streamable HTTP MCP at `POST /mcp`, using the official TypeScript SDK.
Five read-only tools: `whatsapp_search`, `whatsapp_context`, `whatsapp_stats`,
`whatsapp_find_chat` and `whatsapp_find_contact`. All call fixed GET routes on
Alfred's API. No SQL access, writes, generic URLs or filesystem tools.

## Credentials and configuration

Variables are listed in `env.example`. Keep real secrets outside Git:

- `ALFRED_API_URL`: trusted API origin, default `http://alfred-api:8080`. No path,
  credentials, query or fragment. Redirects are refused.
- `ALFRED_API_TOKEN`: dedicated credential with **only `archive.read`**, never the
  legacy full-access `API_TOKEN`.
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
joins only the internal API link. TrueNAS UID/ACL provisioning and host/LAN egress
restrictions remain a separate deployment increment.

There is no persistent adapter state. Add tools through explicit schemas and
fixed-route handlers in `src/tools.ts`, preserving API permission checks and
adding allowed/denied tests. Read-only annotations do not replace authorization.

Protocol serving uses the [official SDK HTTP handler](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md),
with per-request server instances, bearer authentication and Host/Origin guards.

Known [MCP gaps and deployment gates](GAPS.md) are tracked explicitly. A repeatable
[isolated Hermes trial](../smoke/hermes/README.md) exercises this adapter with
synthetic data and Hermes's own discovery/dispatch and agent loop. The optional
real-model mode uses a bounded relay with a separate test key.
