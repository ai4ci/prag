---
class: task
id: core-database-schemas.md
title: Define LanceDB database schemas and interfaces in @prag/core
status: done
priority: high
relates-to:
  - feature:git-branch-awareness.md
blocks:
  - task:lancedb-init-scripts.md
addressed-by:
  - src:core/src/schema.ts#evaluateUriGrants
  - src:core/src/schema.ts#SearchQueryOptions
  - src:core/src/schema.ts#GrantRow
  - src:core/src/database.ts#LanceDbSchema
  - src:core/src/schema.ts#ProjectRow
  - src:core/src/schema.ts#BranchMappingRow
  - src:core/src/schema.ts#FileMappingRow
  - src:core/src/schema.ts#ChunkMappingRow
  - src:core/src/schema.ts#ChunksPoolRow
  - src:core/src/schema.ts#VectorPoolRow
  - src:core/src/schema.ts#SearchHit
  - src:core/src/schema.ts#GrantEvaluation
  - src:core/src/schema.ts#uriMatch
tested-by:
  - coretest:database.test.ts#lanceDbSchemaSuite
  - coretest:database.test.ts#vectorPoolSchemaSuite
  - coretest:database.test.ts#aPIVERSIONSuite
  - coretest:schema.test.ts#evaluateUriGrantsSuite
---
## Objective
Define the shared TypeScript database schemas, table models, and interfaces in `@prag/core` matching the 7-table storage specification.

## Implementation Details
- Tables: `grants`, `projects`, `branch_mapping`, `file_mapping`, `chunk_mapping`, `chunks_pool`, and `vector_pool`.
- Keep the chunk / vectorised-unit split explicit in the types (ADR-014): `chunks_pool` carries `chunkHash` + `text` and no vector; `vector_pool` is keyed `(chunkHash, unitIndex)` and carries the vector.
- Export TypeScript interfaces for records, query filters, and grant evaluation.
- Define column types and schemas compatible with LanceDB / Apache Arrow.

## Implementation status

Audited against code: **done**, all requirement lines satisfied — 7 table models and Arrow schemas
(`packages/core/src/database.ts:104-187`), the ADR-014 split kept explicit
(`chunks_pool` = `chunkHash`/`text`/`scopeContext` with no vector, `packages/core/src/schema.ts:62-66`;
`vector_pool` = `chunkHash`/`unitIndex`/`vector`), record + query-filter + grant-evaluation
interfaces (`schema.ts:16-127`), tested by `coretest:database.test.ts` and
`coretest:schema.test.ts#evaluateUriGrantsSuite`.

One deviation to fix in `task:lancedb-init-scripts.md` rather than here: `vector_pool`'s primary key
is declared as a single column where `design/resources/storage-schema.md:74-78` specifies composite
`(chunkHash, unitIndex)`. Harmless only while nothing writes `unitIndex > 0` — see
`task:ingestion-worker-pool.md`. Also note `SearchQueryOptions` (`schema.ts:77-82`) declares
`branch`, and no producer or consumer populates it; that is dead-until-wired, tracked in
`task:hybrid-search-rrf.md`, not a schema defect.