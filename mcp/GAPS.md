# MCP gaps and deployment gates

Tracked after reviewing the [MCP best-practices checklist](https://modelcontextprotocol.info/docs/best-practices/), 2026-11-11.
Current adapter: dedicated private bearer token, read-only archive scope, no production deployment.

| ID | Status | Gap | Acceptance evidence needed |
|---|---|---|---|
| MCP-01 | Closed in preparation | Per-process authenticated request and upstream concurrency limits | `src/server.test.ts`: rate-window refusal/recovery and blocked concurrent upstream calls/recovery. Defaults 60/minute, four concurrent; HTTP 429 + Retry-After |
| MCP-02 | Open | Static token instead of standard HTTP OAuth authorization | Decide the production auth model; if OAuth, implement resource discovery, issuer/audience/expiry validation and scope challenges, with tests. Document any intentional private-service deviation; do not call it OAuth compliant |
| MCP-03 | Closed in preparation | Committed 2026-07-28 regression coverage | `src/server.test.ts`: discovery, missing/mismatched headers, unsupported version, unknown RPC/tool, invalid input, no session header and GET/DELETE rejection |
| MCP-04 | Closed in preparation | Actionable, sanitized upstream tool errors | `src/server.test.ts`: validation, authentication, permission, missing-message, throttling, availability, redirects, oversized/invalid replies and secret redaction |

The isolated Hermes trial now passes both scripted and real-model scenarios with
synthetic data. This does not validate production deployment. Remaining gates
include origin/write policy before adding writes, host/LAN/IPv6 egress verification,
TrueNAS UID/ACL validation, and backup/restore before importing memory.

Update each row with the fixing commit and test evidence when closing it.
Do not replace an open item with an assumption that the SDK handles it.

## Hermes runtime observations

| ID | Status | Observation | Acceptance evidence needed |
|---|---|---|---|
| HERMES-02 | Open for production | A repeat real-model run returned an unterminated fenced answer under the 2048-token cap; subsequent run passed. The original failed answer was not captured, so truncation is unconfirmed | Retain safe finish-reason/token diagnostics; verify representative prompts under bounded output and validate structured results before taking actions. The trial fails closed on malformed JSON |
| HERMES-01 | Open for production; trial bounded | Provider transient-error retries exceeded the agent's 45-second run budget during the scripted model test | Verify a production wall-clock/call/spend limit across retries and fallbacks. The local harness uses a separate 90-second timeout; do not rely on max_iterations or run_budget_seconds alone |

The optional tool-search bridge replaces the direct MCP schemas with three
discovery/call tools by default. The five-tool pilot explicitly disables it and
checks the actual model-visible catalog. Re-enable it only with equivalent
toolset/denied-call coverage. This is a deliberate pilot setting, not a gap closed
by changing a prompt.

References: [official HTTP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization),
[official transport requirements](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports).

MCP-01, MCP-03 and MCP-04 were fixed in `60d569d`; the real-model trial was added in `e7d59e3`.
