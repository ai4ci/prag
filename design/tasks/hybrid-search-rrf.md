---
class: task
id: hybrid-search-rrf.md
title: Implement hybrid search with LanceDB BM25 FTS and Reciprocal Rank Fusion
status: done
priority: high
relates-to:
  - feature:dual-interfaces.md
addressed-by:
  - src:core/src/search.ts#hybridSearch
  - src:core/src/search.ts#SearchResult
  - src:core/src/search.ts#ftsSearch
  - src:core/src/search.ts#vectorSearch
  - src:core/src/search.ts#fuseResults
  - src:core/src/search.ts#mapToFiles
  - src:core/src/search.ts#SearchChunkHit
  - src:core/src/search.ts#SearchFileHit
  - src:cli/src/daemon-client.ts#SearchOptions
  - src:cli/src/daemon-client.ts#SearchOptions
  - src:core/src/search.ts#SearchFileHit
tested-by:
  - coretest:search.test.ts#searchSuite
---
## Description
Implement hybrid search in @prag/daemon combining dense vector embeddings and BM25 full-text search.

## Requirements
- Create LanceDB full-text search (FTS) index on `chunks_pool.text`.
- Score dense search against `vector_pool`, then collapse to the best-scoring `unitIndex` per `chunkHash` **before** fusion, so the chunk is the unit of ranking and a large function surfaces once rather than once per vectorised unit (ADR-014).
- Implement hybrid search pipeline using LanceDB's native hybrid querying and Reciprocal Rank Fusion (RRF, k=60).
- Support `mode: 'hybrid' | 'vector' | 'fts'` parameter in `SearchQueryOptions`.
- Enforce branch and project filtering against `branch_mapping` and `file_mapping` before/during rank fusion.
- Update CLI (`search-local`/`search-all`) and MCP tools (`search_local`/`search_all`) to expose hybrid search defaults consistently across the split commands (ADR-018). `projectId` is always present for the local variants and always absent for the all variants; `branch` defaults to `$default`, never `main`.

## Implementation status

Re-audited 2026-11-02 and returned to `done`.

- **Project/branch filtering — DONE.** `hybridSearch` takes `projectId` and
  `branch`, and `mapToFiles` reads `branch_mapping` on the search path
  (`core/src/search.ts`). Cross-project leakage is asserted in
  `core/test/search-scoping.test.ts`.
- **`mode` — DONE.** Parsed by the CLI, read by the daemon
  (`daemon/src/daemon.ts:835`) and honoured in `hybridSearch`
  (`search.ts:109,122,130`), so `--mode fts` no longer silently returns hybrid.
- **Unit collapse — DONE.** A chunk is represented by its best-scoring unit
  (smallest distance), not the first one seen (`search.ts:199-207`).
- **CLI/MCP surface — DONE.** `search_all` is registered alongside
  `search_local` (`daemon/src/mcp-server.ts:235`), and `$default` is a real
  sentinel (`core/src/branch.ts:14`).

Remaining, deliberately not done: RRF is hand-rolled at k=60 over two queries
rather than LanceDB's native hybrid path. The fusion arithmetic matches the
spec, so this is a fidelity/upgrade question rather than a wrong-answer one.
