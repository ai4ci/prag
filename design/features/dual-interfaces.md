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
---
## Overview
Stored data is queryable via a short-lived, low-latency Command Line Interface (CLI) (<15ms response time) and natively exposed as a Model Context Protocol (MCP) server directly inside the `@prag/daemon` process over HTTP/SSE (`http://127.0.0.1:7724/mcp`). Both interfaces share the daemon's warm in-memory ONNX embedding model and LanceDB connection, utilizing **Hybrid Search** (Dense Vector + BM25 Full-Text Search with Reciprocal Rank Fusion).

## Hybrid Search Engine Architecture
Queries combine neural semantic search and exact keyword matching:
1. **Dense Vector Search:** Encodes the natural language query into a vector using the hot in-memory model and computes cosine similarity against `chunks_pool.vector`.
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

## Query Engine Interface
```typescript
export interface SearchQueryOptions {
  query: string;           // Natural language or keyword search query
  activeBranch: string;    // Target branch context to enforce
  projectId?: string;      // Optional specific project filter
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
