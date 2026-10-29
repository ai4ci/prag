---
class: task
id: hybrid-search-rrf.md
title: Implement hybrid search with LanceDB BM25 FTS and Reciprocal Rank Fusion
status: todo
priority: high
relates-to:
  - feature://dual-interfaces.md
addressed-by:
  - src://core/src/search.ts#hybridSearch
  - src://core/src/search.ts#SearchResult
  - src://core/src/search.ts#ftsSearch
  - src://core/src/search.ts#vectorSearch
  - src://core/src/search.ts#fuseResults
  - src://core/src/search.ts#mapToFiles
  - src://core/src/search.ts#SearchChunkHit
  - src://core/src/search.ts#SearchFileHit
  - src://cli/src/daemon-client.ts#SearchOptions
  - src://cli/src/daemon-client.ts#SearchHit
  - src://cli/src/daemon-client.ts#SearchResult
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