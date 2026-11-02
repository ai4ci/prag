---
class: task
id: mcp-server-endpoint.md
title: Expose native HTTP/SSE Model Context Protocol (MCP) server endpoint in daemon
status: in_progress
priority: medium
relates-to:
  - feature:dual-interfaces.md
addressed-by:
  - src:daemon/src/mcp-server.ts#McpHandler
tested-by:
  - daemontest:mcp-server.test.ts#mCPServerSuite
---
## Objective
Expose the Model Context Protocol (MCP) server directly inside `@prag/daemon` on the loopback HTTP/SSE endpoint `/mcp` (e.g. `http://127.0.0.1:7724/mcp`).

## Implementation Details
- Integrate `@modelcontextprotocol/sdk` utilizing the HTTP/SSE transport (`SSEServerTransport` / express/hono/node http handler).
- Register MCP tools:
  - `search_local` / `search_all`: Connect directly to the daemon's in-process `SearchEngine` (hybrid vector + BM25 RRF), scoped vs. unscoped respectively (ADR-018). `search_local` declares `projectId` as **required** -- the daemon has no access to an MCP caller's working directory, so a missing `projectId` is an error, never a silent widening to every project. `search_all` declares no `projectId` at all. `branch` defaults to `$default` on both.
  - `get_indexing_status`: Inspect watched workspace metadata, active branch, and chunk metrics.
  - `watch_uri`: Register allow grant and trigger immediate background indexing scan.
  - `deny_uri`: Register deny grant, exclude pattern from search, and halt watchers.
  - `prune_index`: Prune stale branch pointers and, only when `gcChunks: true` is explicitly passed, garbage-collect unreferenced `chunks_pool` rows and their `vector_pool` rows, draining and pausing the ingestion queue for the sweep (ADR-017).
- Support concurrent agent connections over local loopback without spawning extra child processes.
- Enforce the bearer-token check (ADR-013) on the `/mcp` transport the same as every other endpoint.

## Implementation status

Reverted from `done`: the SSE transport and three tools work, but four of the six
required tools do not exist, and the one tool that advertises scoping does not scope.

- **Three tools registered, six required** (`packages/daemon/src/mcp-server.ts:72,116,147`:
  `search_local`, `list_grants`, `list_projects`). MISSING: `search_all`,
  `get_indexing_status`, `watch_uri`, `deny_uri`, `prune_index` — each grepped by name in
  `packages/daemon/src`, no match. `list_grants`/`list_projects` are additions the
  interface document does not list; keep them, they are not a substitute.
- **`search_local` does not scope.** It declares `projectId` as required and echoes it into
  the response payload without filtering on it (`mcp-server.ts:72-102`), because
  `hybridSearch` accepts no project parameter (`packages/core/src/search.ts:53-58`). To an
  agent this reads as enforcement while returning hits from every project — the exact
  silent-widening failure the requirement forbids. Tracked as
  `task:search-project-scoping.md`; also no `branch` handling, so `$default` is not applied.
- **`prune_index` absence is load-bearing, not just missing surface.** Without it there is no
  MCP path to GC, and the unlink/prune paths that *do* delete pool rows do so unconditionally
  — see `issue:unlink-prune-deletes-shared-pool-rows.md`.
- **MCP errors carry no code.** Failures return `{ content: [{ type: "text", text:
  "Search error: ..." }], isError: true }` (`mcp-server.ts:100-110`, `:127-137`, `:161-171`),
  violating the `code`+`message` requirement and `task:error-contract.md:28`.

Satisfied: `SSEServerTransport` per-connection (`mcp-server.ts:195`, concurrent sessions
held in a `Map` at `:26`, no child processes), and the bearer check — `/mcp` is dispatched
inside `_handle` after the auth gate (`packages/daemon/src/daemon.ts:265-278`) and is not on
the `/health` exemption list.

Remaining: add the four missing tools (with `WATCH_LIMIT_EXCEEDED` on `watch_uri` and
`gcChunks` gating on `prune_index`), pass `projectId`/branch into search once
`task:search-project-scoping.md` lands, and return structured error codes.
