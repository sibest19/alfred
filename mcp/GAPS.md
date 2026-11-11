# MCP gaps and deployment gates

Tracked after reviewing the [MCP best-practices checklist](https://modelcontextprotocol.info/docs/best-practices/), 2026-11-11.
Current adapter: dedicated private bearer token, read-only archive scope, no production deployment.

| ID | Status | Gap | Acceptance evidence needed |
|---|---|---|---|
| MCP-01 | Open | No invocation rate or concurrency limit | A bounded policy and tests proving overload is refused before upstream calls, with recovery afterwards |
| MCP-02 | Open | Static token instead of standard HTTP OAuth authorization | Decide the production auth model; if OAuth, implement resource discovery, issuer/audience/expiry validation and scope challenges, with tests. Document any intentional private-service deviation; do not call it OAuth compliant |
| MCP-03 | Open | 2026-07-28 protocol probes are not committed regression tests | Commit discovery, header mismatch, version rejection, unknown method/tool, validation-error and statelessness tests. Temporary local probes passed, but are not CI coverage |
| MCP-04 | Open | Upstream errors are safe but too generic for recovery | Distinguish actionable authorization, missing-message, validation and availability failures without leaking credentials or raw upstream errors; test them |

The isolated Hermes trial uses fixtures and an internal network. Its success does
not close these gaps. Existing deployment gates also include a real Hermes/model
trial, origin/write policy before adding writes, host/LAN/IPv6 egress verification,
TrueNAS UID/ACL validation, and backup/restore before importing memory.

Update each row with the fixing commit and test evidence when closing it.
Do not replace an open item with an assumption that the SDK handles it.

References: [official HTTP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization),
[official transport requirements](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports).
