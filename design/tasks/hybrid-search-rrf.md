---
class: task
id: hybrid-search-rrf.md
title: Implement hybrid search with LanceDB BM25 FTS and Reciprocal Rank Fusion
status: in_progress
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

Reverted from `done`: the two retrieval arms and RRF fusion work and are tested, but the search
is unscoped, `mode` is decorative, and the unit-collapse is not score-ordered.

- **Project/branch filtering — MISSING.** `hybridSearch` has no `projectId` or `branch`
  parameter at all (`packages/core/src/search.ts:53-61`), and neither `ftsSearch` (`:89`) nor
  `vectorSearch` (`:111`) nor `mapToFiles` (`:211`) adds a `where` clause; `branch_mapping` is
  never read on the search path (only in prune, `packages/daemon/src/daemon.ts:622`). Every
  search returns hits from every project and every branch. Tracked for implementation in
  `task:search-project-scoping.md`.
- **`mode` — MISSING.** Not in `SearchQueryOptions` (`packages/core/src/schema.ts:77-82`);
  `grep -n mode packages/core/src/schema.ts packages/daemon/src/daemon.ts` → no match. The CLI
  parses `--mode` (`packages/cli/src/main.ts:179`) and sends it on the wire
  (`daemon-client.ts:308`); `_handleSearch` reads only `query`/`limit`
  (`daemon.ts:339-351`) and drops it. A user selecting `--mode fts` silently gets hybrid.
- **Unit collapse is not "best-scoring" — PARTIAL.** `search.ts:129-139` keeps the **first**
  row per `chunkHash` in LanceDB return order and never compares `_distance`, so a chunk's score
  is whichever unit happened to come back first, not the best one. The ADR-014 requirement ("the
  chunk is the unit of ranking") is only accidentally satisfied when return order agrees with
  distance order.
- **Native hybrid — PARTIAL.** RRF k=60 is hand-rolled (`search.ts:36 RRF_K`, `fuseResults:172-207`)
  over two separate queries; `grep mergeType` → no match, so LanceDB's native hybrid path is not
  used. The fusion arithmetic matches the spec, so this is a fidelity/upgrade question, not a
  wrong-answer one — worth confirming against the installed version before changing.
- **CLI/MCP surface — PARTIAL.** `search-local`/`search-all` exist and `search-all` correctly
  omits `projectId` (`main.ts:177-186`); MCP registers `search_local` only
  (`packages/daemon/src/mcp-server.ts:72`) — no `search_all` tool (`grep` in that file → no
  match). `branch` is never sent by any caller and `$default` has no match anywhere in
  `packages/*/src`, so the "defaults to `$default`, never `main`" rule is unenforced.
- **Client/server payload shapes disagree.** `SearchHit{filePath,projectId,score,totalChunks,branch}`
  (`daemon-client.ts:19-25`) vs `SearchFileHit{uri,fileVersionId,...}`
  (`search.ts:28-32`); `main.ts:207-211` prints fields that are `undefined` against the real
  response and labels the fused-chunk count as "total chunks indexed".

Satisfied: FTS index on `chunks_pool.text` (`database.ts:166,291`); RRF k=60 fusion
(`search.ts:36,172-207`, `coretest:search.test.ts#searchSuite`); the local/all CLI split.

Remaining: land `task:search-project-scoping.md`, thread `mode` through
`SearchQueryOptions`→daemon→both arms, take the min-distance unit per chunk, add the MCP
`search_all` tool, and reconcile the hit shape so the CLI prints real fields.