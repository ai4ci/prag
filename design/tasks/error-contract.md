---
class: task
id: error-contract.md
title: Implement the unified error envelope, status mapping and exit codes
status: todo
priority: high
relates-to:
  - feature:dual-interfaces.md
blocks:
  - task:test-harness-lifecycle.md
addressed-by:
  - src:cli/src/daemon-client.ts#DaemonError
  - src:cli/src/daemon-client.ts#ExitCode
  - src:cli/src/daemon-client.ts#ErrorEnvelope
  - src:cli/src/daemon-client.ts#parseError
---
## Objective
Implement ADR-022 so failures have one shape across the HTTP API, the CLI and the MCP tools, and so tests assert on a stable `code` rather than on message text.

## Requirements
- Export a closed `ErrorCode` union and an `error` envelope type (`{ code, message, remedy, details? }`) from `@prag/core`. Every failure path in the daemon returns it; no endpoint returns a bare string or an unwrapped exception.
- Implement the HTTP status mapping from ADR-022 (400/401/404/409/422/503/504/500). `500` is reserved for bugs: log the stack trace, return a generic message, never leak internals to a caller that may be an agent.
- Wire the codes the existing ADRs already describe in prose: `DAEMON_IDENTITY_MISMATCH` and `API_VERSION_MISMATCH` (ADR-016), `EMBEDDING_MODEL_MISMATCH` (ADR-015), `UNAUTHORIZED` and `ORIGIN_REJECTED` (ADR-013), `PROJECT_ID_REQUIRED` (ADR-018), `SYNC_TIMEOUT` (ADR-019), `WATCH_LIMIT_EXCEEDED` (ADR-023). Each carries the `remedy` sentence those ADRs specify.
- Implement the CLI exit-code table. A search that matches nothing exits `0` — empty results are a valid answer, not a failure.
- Default CLI rendering prints `message` then `remedy`, nothing more. `--json` emits the envelope verbatim.
- MCP tool failures carry `code` and `message` into the MCP error so an agent gets a machine-readable reason.

## Verification
- Every `ErrorCode` has at least one test that triggers it and asserts the code, the HTTP status and the CLI exit code together.
- Rewording any `message` breaks no test — the assertion surface is `code` only. Verify by changing one message and confirming the suite still passes.
- `prag search-local` with a query matching nothing exits `0` and prints no error.
