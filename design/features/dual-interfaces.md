---
class: feature
id: dual-interfaces.md
title: Dual Interface (Short-Lived CLI and Native HTTP/SSE MCP Endpoint)
status: accepted
priority: high
area: interface
guided-by:
  - adr://ADR-001.md
  - adr://ADR-005.md
  - adr://ADR-007.md
  - adr://ADR-011.md
  - adr://ADR-013.md
  - adr://ADR-018.md
  - adr://ADR-016.md
  - adr://ADR-022.md
---
## Overview
Stored data is queryable via a short-lived, low-latency Command Line Interface (CLI) (<100ms response time) and natively exposed as a Model Context Protocol (MCP) server directly inside the `@prag/daemon` process over HTTP/SSE (`http://127.0.0.1:7724/mcp`). Both interfaces share the daemon's warm in-memory ONNX embedding model and LanceDB connection, utilizing **Hybrid Search** (Dense Vector + BM25 Full-Text Search with Reciprocal Rank Fusion). Search is exposed as two explicit commands/tools, not one optionally-scoped one: `search-local`/`search_local` (default, scoped to exactly one project) and `search-all`/`search_all` (unscoped, cross-project, accepts no project argument) -- see ADR-018. The CLI resolves `search-local`'s `projectId` from the working directory; MCP callers must pass it, since the in-daemon MCP server has no caller working directory to resolve.

## Hybrid Search Engine Architecture
Queries combine neural semantic search and exact keyword matching:
1. **Dense Vector Search:** Encodes the natural language query into a vector using the hot in-memory model and computes cosine similarity against `vector_pool.vector`, then collapses to the best-scoring vectorised unit per `chunkHash` so the chunk is the unit of ranking (ADR-014).
2. **BM25 Lexical Search:** Runs full-text search against `chunks_pool.text` using LanceDB's native inverted FTS index, ensuring exact symbol and function names match.
3. **Reciprocal Rank Fusion (RRF):** Fuses dense and lexical ranks into a unified relevance score.
4. **Branch & Project Filtering:** Restricts candidate chunks to the active branch pointer in `branch_mapping` and target workspace `projectId`.

## Daemon Communication & Lazy Startup
- **Transport:** HTTP/JSON over `http://127.0.0.1:<port>` (default port `7724`, configured in `~/.config/prag/config.json`).
- **Native MCP Endpoint:** The daemon hosts the official MCP server transport at `/mcp`. Agents connect directly via SSE/HTTP.
- **Lazy Auto-Spawn:** When invoked, `@prag/cli` checks `GET /health`. If unreachable, it spawns the background daemon detached (`child_process.spawn(..., { detached: true, stdio: 'ignore' })`), polls until `/health` returns `{ status: "ok" }`, and executes the query.
- **Daemon Lifecycle CLI Commands:**
  - `prag daemon start`: Starts the daemon process explicitly if not already running.
  - `prag daemon status`: Reports running state, PID, bound port, registered workspaces, and memory footprint.
  - `prag daemon stop`: Sends graceful termination request (`POST /shutdown`) and cleans up PID tracking.
  - Lifecycle subcommands (`stop`, `status`, `token`, `rotate-secret`) are exempt from the `/health` `apiVersion` check, so they still work against a protocol-skewed daemon (ADR-016).

## Query Engine Interface
```typescript
export interface SearchQueryOptions {
  query: string;           // Natural language or keyword search query
  activeBranch?: string;   // Target branch context to enforce; defaults to '$default' if omitted (the daemon does not auto-detect git branch itself -- the CLI resolves it from local .git/HEAD before calling /search)
  projectId?: string;      // Project filter. Always set by search-local/search_local, always absent for search-all/search_all (ADR-018)
  limit?: number;          // Top-K results (default: 5)
  mode?: 'hybrid' | 'vector' | 'fts'; // Search mode (default: 'hybrid')
}

export interface SearchHitResult {
  chunkHash: string;
  filePath: string;
  projectId: string;
  branch: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number;
  language: string;
  scopeContext?: string;
}
```
