---
class: task
id: mcp-server-endpoint.md
title: Expose native HTTP/SSE Model Context Protocol (MCP) server endpoint in daemon
status: done
priority: medium
relates-to:
  - feature:dual-interfaces.md
addressed-by:
  - src:daemon/src/mcp-server.ts#McpHandler
  - src:daemon/src/mcp-server.ts#toolFailure
  - src:daemon/src/mcp-server.ts#McpOperations
  - src:daemon/src/daemon.ts#watchUri
  - src:daemon/src/daemon.ts#applyGrant
  - src:daemon/src/daemon.ts#prune
  - src:daemon/src/daemon.ts#statusFor
  - src:daemon/src/daemon.ts#currentBranchFor
  - src:daemon/src/ingestion-queue.ts#IngestionQueue.registerProject
  - src:core/src/errors.ts#DaemonFailure
tested-by:
  - daemontest:mcp-server.test.ts#mCPServerSuite
  - daemontest:mcp-tools.test.ts#mcpPolicyToolSuite
---
## Objective
Expose the Model Context Protocol (MCP) server directly inside `@prag/daemon` on the loopback HTTP/SSE endpoint `/mcp` (e.g. `http://127.0.0.1:7724/mcp`).

## Implementation Details
- Integrate `@modelcontextprotocol/sdk` utilizing the HTTP/SSE transport (`SSEServerTransport` / express/hono/node http handler).
- Register MCP tools:
  - `search_local` / `search_all`: Connect directly to the daemon's in-process `SearchEngine` (hybrid vector + BM25 RRF), scoped vs. unscoped respectively (ADR-018). `search_local` declares `projectId` as **required** -- the daemon has no access to an MCP caller's working directory, so a missing `projectId` is an error, never a silent widening to every project. `search_all` declares no `projectId` at all. Branch scoping: see the deviations below.
  - `get_indexing_status`: Inspect watched workspace metadata, active branch, and chunk metrics.
  - `watch_uri`: Register allow grant and trigger immediate background indexing scan.
  - `deny_uri`: Register deny grant, exclude pattern from search, and halt watchers.
  - `prune_index`: Prune stale branch pointers and, only when `gcChunks: true` is explicitly passed, garbage-collect unreferenced `chunks_pool` rows and their `vector_pool` rows, draining and pausing the ingestion queue for the sweep (ADR-017).
- Support concurrent agent connections over local loopback without spawning extra child processes.
- Enforce the bearer-token check (ADR-013) on the `/mcp` transport the same as every other endpoint.

## Implementation status

All eight tools are registered (`search_local`, `search_all`, `watch_uri`,
`deny_uri`, `get_indexing_status`, `prune_index`, `list_grants`,
`list_projects`) and driven end to end over a real JSON-RPC/SSE session by
`packages/daemon/test/mcp-tools.test.ts`, including the ADR-022 envelope shape.

The policy tools call `Daemon` methods rather than reaching for the tables, which
is what makes the two interfaces agree: `watchUri`, `applyGrant`, `prune` and
`statusFor` throw `DaemonFailure`, the HTTP routes call the same methods, and
`McpOperations` is the thunk object wiring them in. A tool that wrote a grant row
directly would skip the cache invalidation, the purge from search and the unwatch
`prag deny` performs (ADR-009 §4).

`prune_index` calls `Daemon.prune`, which sweeps `chunk_mapping`/`file_mapping`
pointers, dead branches and unreferenced file versions, and only with
`gcChunks: true` deletes from `chunks_pool` **and** `vector_pool` and compacts both
(`gcUnreferencedChunks`), with ingestion drained and paused for the sweep.

## Deviations from the interface contract

- **`search_local.branch` defaults to the checked-out branch, not `$default`.** A git
  workspace's files are indexed under their real branch, so the documented default
  would have returned nothing for the common case. The response echoes the applied
  `branch` so the scope is visible rather than trusted.
- **`search_all` has no `branch`.** A branch identifies a version of one project's
  files; a filter spanning projects cannot mean anything, and accepting one silently
  is the widening the `projectId` rule exists to prevent. Response `branch` is `null`.
- **`watch_uri` has no `confirm`.** Past `ingestion.watchConfirmThreshold` it fails with
  `WATCH_LIMIT_EXCEEDED` and the dry-run counts in `details`; only a human escalates
  with `--yes` (ADR-023). Both recorded in `resource:cli-and-mcp-interface.md`.

## Defects fixed on the way

- **One `McpServer` per session.** The shared instance made every `GET /mcp` after the
  first live stream answer 500: the SDK's `Protocol.connect` throws "Already connected
  to a transport". Two agents on one daemon is the expected setup (ADR-019), so the
  concurrency requirement was not actually met until this changed.
- **Per-project cooldown.** `watch_uri`'s `cooldownSeconds` needed it; previously one
  timer length from config applied to every project.
