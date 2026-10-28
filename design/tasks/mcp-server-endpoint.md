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
  - `semantic_repository_search`: Connect directly to the daemon's in-process `SearchEngine` (hybrid vector + BM25 RRF).
  - `get_indexing_status`: Inspect watched workspace metadata, active branch, and chunk metrics.
  - `watch_uri`: Register allow grant and trigger immediate background indexing scan.
  - `deny_uri`: Register deny grant, exclude pattern from search, and halt watchers.
- Support concurrent agent connections over local loopback without spawning extra child processes.
