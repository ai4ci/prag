---
class: task
id: error-contract.md
title: Implement the unified error envelope, status mapping and exit codes
status: done
priority: high
relates-to:
  - feature:dual-interfaces.md
blocks:
  - task:test-harness-lifecycle.md
addressed-by:
  - src:core/src/errors.ts#ErrorEnvelope
  - src:core/src/errors.ts#exitForCode
  - src:core/src/errors.ts#DaemonFailure
  - src:cli/src/daemon-client.ts#DaemonError
  - src:cli/src/daemon-client.ts#ExitCode
  - src:cli/src/daemon-client.ts#classifyFailure
  - src:cli/src/daemon-client.ts#parseError
  - src:daemon/src/daemon.ts#Daemon.sendError
  - src:daemon/src/daemon.ts#Daemon.sendInternal
  - src:daemon/src/daemon.ts#Daemon.sendFailure
  - src:daemon/src/mcp-server.ts#toolFailure
  - src:daemon/src/mcp-server.ts#writeEnvelope
tested-by:
  - clitest:daemon-client.test.ts#daemonClientSuite
  - clitest:subprocess-e2e.test.ts#subprocessEndToEndSuite
  - coretest:errors.test.ts#errorCodeContractSuite
  - daemontest:error-envelope.test.ts#errorEnvelopeSuite
---
## Objective
Implement ADR-022 so failures have one shape across the HTTP API, the CLI and the MCP tools, and so tests assert on a stable `code` rather than on message text.

## Requirements
- Export a closed `ErrorCode` union and an `error` envelope type (`{ code, message, remedy, details? }`) from `@prag/core`. Every failure path in the daemon returns it; no endpoint returns a bare string or an unwrapped exception.
- Implement the HTTP status mapping from ADR-022 (400/401/404/409/422/503/504/500). `500` is reserved for bugs: log the stack trace, return a generic message, never leak internals to a caller that may be an agent.
- Wire the codes the existing ADRs already describe in prose: `DAEMON_IDENTITY_MISMATCH` and `API_VERSION_MISMATCH` (ADR-016), `EMBEDDING_MODEL_MISMATCH` (ADR-015), `UNAUTHORIZED` and `ORIGIN_REJECTED` (ADR-013), `PROJECT_ID_REQUIRED` (ADR-018), `SYNC_TIMEOUT` (ADR-019), `WATCH_LIMIT_EXCEEDED` (ADR-023), `CRAWL_CAPABILITY_UNAVAILABLE` (ADR-024). Each carries the `remedy` sentence those ADRs specify.
- Implement the CLI exit-code table. A search that matches nothing exits `0` — empty results are a valid answer, not a failure.
- Default CLI rendering prints `message` then `remedy`, nothing more. `--json` emits the envelope verbatim.
- MCP tool failures carry `code` and `message` into the MCP error so an agent gets a machine-readable reason.

## Verification
- Every `ErrorCode` has at least one test that triggers it and asserts the code, the HTTP status and the CLI exit code together.
- Rewording any `message` breaks no test — the assertion surface is `code` only. Verify by changing one message and confirming the suite still passes.
- `prag search-local` with a query matching nothing exits `0` and prints no error.

## Implementation status
Done. Executed verification:
- **Code set + both mappings:** `packages/core/test/errors.test.ts` asserts the code list literally, that `HTTP_STATUS_FOR_CODE` and `EXIT_FOR_CODE` cover exactly the same keys, and that every status is one ADR-022 §2 names. A new code with no exit code fails there.
- **Daemon answers with envelopes:** `packages/daemon/test/error-envelope.test.ts` triggers UNAUTHORIZED, ORIGIN_REJECTED, NOT_FOUND, METHOD_NOT_ALLOWED, INVALID_REQUEST, PROJECT_NOT_FOUND, WATCH_LIMIT_EXCEEDED, CRAWL_BACKEND_REQUIRED, EMBEDDING_MODEL_MISMATCH and asserts `{error:{code,message,remedy?,details?}}` plus the status implied by the shared table — so a handler cannot drift from the mapping.
- **End-to-end code + exit code:** `packages/cli/test/subprocess-e2e.test.ts` runs the real CLI against a spawned daemon and asserts `prag search-local -p <unregistered>` exits `7` (NOT_GRANTED) *and* that `--json` carries `code: PROJECT_NOT_FOUND`.
- **Zero-result search exits 0:** asserted in the same file (fts mode, since the vector side always returns a nearest neighbour).
- **Message rewording breaks nothing:** performed for real — `PROJECT_NOT_FOUND` and `REEMBED_IN_PROGRESS` messages were changed to nonsense and all 59 daemon tests still passed.
- **No bare strings left:** `grep -rn 'res.end("' packages/daemon/src` matches only `res.end("[]")` (a valid empty JSON array). The MCP SSE 500 was the last prose body and now sends an envelope.
- **`500` leaks nothing:** `sendInternal` logs the stack and answers generically (ADR-022 §4).

Not covered, deliberately: `CRAWL_CAPABILITY_UNAVAILABLE` has no producer yet — the fetch-backend plugin of ADR-024 that raises it is unimplemented, so it appears in the code set and mappings only. `DAEMON_IDENTITY_MISMATCH` is raised by the client (`daemon-client.ts`) and covered at the mapping level only.
