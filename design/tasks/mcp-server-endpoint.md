---
class: task
id: mcp-server-endpoint.md
title: Expose native HTTP/SSE Model Context Protocol (MCP) server endpoint in daemon
status: todo
priority: medium
relates-to:
  - feature://dual-interfaces.md
---
## Objective
Expose the Model Context Protocol (MCP) server directly inside `@prag/daemon` on the loopback HTTP/SSE endpoint `/mcp` (e.g. `http://127.0.0.1:7724/mcp`).

## Implementation Details
- Integrate `@modelcontextprotocol/sdk` utilizing the HTTP/SSE transport (`SSEServerTransport` / express/hono/node http handler).
- Register MCP tools:
  - `search_local` / `search_all`: Connect directly to the daemon's in-process `SearchEngine` (hybrid vector + BM25 RRF), scoped vs. unscoped respectively (ADR-018).
  - `get_indexing_status`: Inspect watched workspace metadata, active branch, and chunk metrics.
  - `watch_uri`: Register allow grant and trigger immediate background indexing scan.
  - `deny_uri`: Register deny grant, exclude pattern from search, and halt watchers.
  - `prune_index`: Prune stale branch pointers and, only when `gcChunks: true` is explicitly passed, garbage-collect unreferenced `chunks_pool` rows (ADR-017).
- Support concurrent agent connections over local loopback without spawning extra child processes.
- Enforce the bearer-token check (ADR-013) on the `/mcp` transport the same as every other endpoint.
