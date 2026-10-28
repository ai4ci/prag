---
class: task
id: hybrid-search-rrf.md
title: Implement hybrid search with LanceDB BM25 FTS and Reciprocal Rank Fusion
status: todo
priority: high
relates-to:
  - feature://dual-interfaces.md
---
## Description
Implement hybrid search in @prag/daemon combining dense vector embeddings and BM25 full-text search.

## Requirements
- Create LanceDB full-text search (FTS) index on `chunks_pool.text`.
- Implement hybrid search pipeline using LanceDB's native hybrid querying and Reciprocal Rank Fusion (RRF, k=60).
- Support `mode: 'hybrid' | 'vector' | 'fts'` parameter in `SearchQueryOptions`.
- Enforce branch and project filtering against `branch_mapping` and `file_mapping` before/during rank fusion.
- Update CLI (`search-local`/`search-all`) and MCP tools (`search_local`/`search_all`) to expose hybrid search defaults consistently across the split commands (ADR-018).