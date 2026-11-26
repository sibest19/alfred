# MCP gaps and deployment gates

Tracked after reviewing the [MCP best-practices checklist](https://modelcontextprotocol.info/docs/best-practices/), 2026-11-11.
Current adapter: dedicated private bearer token (MCP-02, intentional for a single internal client), read-only archive and mail scopes, calendar and to-do writes (MCP-05).

| ID | Status | Gap | Acceptance evidence needed |
|---|---|---|---|
| MCP-01 | Closed in preparation | Per-process authenticated request and upstream concurrency limits | `src/server.test.ts`: rate-window refusal/recovery and blocked concurrent upstream calls/recovery. Defaults 60/minute, four concurrent; HTTP 429 + Retry-After |
| MCP-02 | Closed: intentional deviation | Static bearer token instead of standard HTTP OAuth authorization | Decision: the adapter is a private service reachable only from an internal container network, with one known client (Hermes). It keeps one static bearer token (`MCP_TOKEN`, at least 16 bytes, distinct from its API credential, compared in constant time) and is **not** OAuth compliant. Revisit before exposing it beyond that network or to more than one client: then implement resource discovery, issuer/audience/expiry validation and scope challenges, with tests |
| MCP-03 | Closed in preparation | Committed 2026-07-28 regression coverage | `src/server.test.ts`: discovery, missing/mismatched headers, unsupported version, unknown RPC/tool, invalid input, no session header and GET/DELETE rejection |
| MCP-04 | Closed in preparation | Actionable, sanitized upstream tool errors | `src/server.test.ts`: validation, authentication, permission, missing-message, throttling, availability, redirects, oversized/invalid replies and secret redaction |
| MCP-05 | Closed: write policy | Writes to the owner's calendars and to-dos (create, change, complete, delete) | Only those resources, by 8-hex ids from a listing (no path injection), each write tool annotated `readOnlyHint: false` (deletes also destructive) so a client that gates write-capable tools asks first: Hermes with `trust: untrusted` asks the user for every call (once, for the session, or always), and its unattended scheduled runs cannot approve, so they cannot write, except a tool approved "always" (kept in `command_allowlist`, honoured by scheduled runs too) or with `approvals.mode: off` (`hermes/README.md`, Scheduled jobs). The API refuses overwriting a phone's concurrent change (ETag, 409) and never touches whole collections. `src/server.test.ts`: write methods, paths and bodies; invalid ids refused before the API |

The isolated Hermes trial now passes both scripted and real-model scenarios with
synthetic data. This does not validate production deployment. Remaining gates
include host/LAN/IPv6 egress verification,
Host UID/ACL validation, and backup/restore before importing memory.

Update each row with the fixing commit and test evidence when closing it.
Do not replace an open item with an assumption that the SDK handles it.

## Hermes runtime observations

| ID | Status | Observation | Acceptance evidence needed |
|---|---|---|---|
| HERMES-02 | Open for production | Some real-model replies violate the JSON-only request. A later diagnostic run returned valid fenced JSON followed by evidence prose, which the strict check rejected; the original failure was not captured | Retain safe finish-reason/token diagnostics; verify representative prompts under bounded output and validate structured results before taking actions. The trial fails closed on malformed JSON |
| HERMES-01 | Open for production; retries bounded by config | Provider transient-error retries exceeded the agent's 45-second run budget during the scripted model test. Hermes v0.23.3 has no hard wall-clock limit: `run_budget_seconds` mainly asks the model to wrap up, while attempts per call (`api_max_retries`, 3), recovery cycles after them (`auto_recovery_cycles`, 5) and `Retry-After` waits (capped at 600 s each) run outside it | [`hermes/config.example.yaml`](../hermes/config.example.yaml) sets a single attempt per call, no recovery cycles, 40 turns and no fallback providers; `hermes/check.sh` checks the values Hermes resolves from it in the pinned image. Still needed: a hard per-run wall-clock limit (upstream, or a supervisor around scheduled runs). The local harness uses a separate 90-second timeout |

The optional tool-search bridge replaces the direct MCP schemas with three
discovery/call tools by default. The five-tool pilot explicitly disables it and
checks the actual model-visible catalog. Re-enable it only with equivalent
toolset/denied-call coverage. This is a deliberate pilot setting, not a gap closed
by changing a prompt.

References: [official HTTP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization),
[official transport requirements](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports).

MCP-01, MCP-03 and MCP-04 were fixed in `60d569d`; the real-model trial was added in `e7d59e3`.
