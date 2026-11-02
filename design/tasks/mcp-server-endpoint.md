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
