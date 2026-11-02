---
class: task
id: lancedb-init-scripts.md
title: Implement LanceDB initialization scripts with 7-table schema setup
status: in_progress
priority: high
relates-to:
  - feature:git-branch-awareness.md
blocks:
  - task:daemon-ingestion-queue.md
  - task:cli-read-only-search.md
addressed-by:
  - src:core/src/database.ts#LanceDbSchema
  - src:core/src/database.ts#DatabaseConfig
  - src:core/src/database.ts#TableDefinition
  - src:core/src/database.ts#vectorPoolDef
  - src:core/src/database.ts#upsertGrants
  - src:core/src/database.ts#upsertProjects
  - src:core/src/database.ts#upsertBranchMapping
  - src:core/src/database.ts#upsertFileMapping
  - src:core/src/database.ts#upsertChunkMapping
  - src:core/src/database.ts#upsertChunksPool
  - src:core/src/database.ts#upsertVectorPool
tested-by:
  - coretest:database.test.ts#lanceDbSchemaSuite
  - coretest:database.test.ts#vectorPoolSchemaSuite
---
## Objective
Implement initialization scripts and table bootstrap utilities for LanceDB in `@prag/core`.

## Implementation Details
- Connect to local LanceDB instance using Apache Arrow settings.
- Implement table creation and schema verification for the 7-table schema (`grants`, `projects`, `branch_mapping`, `file_mapping`, `chunk_mapping`, `chunks_pool`, `vector_pool`).
- Create BM25 full-text search (FTS) index on `chunks_pool.text`, and the vector index on `vector_pool.vector` (ADR-014).
- Validate `embedding.maxVectorUnitTokens` against the active model's reported maximum sequence length at startup and refuse to initialize if it exceeds it (ADR-014).
- Provide helper methods for transactional batch upserts of chunks and mapping pointers.

## Implementation status

Reverted from `done`: connection, table bootstrap and both indexes work; schema
verification, the ADR-014 startup gate and "transactional upserts" do not.

- **No schema verification — PARTIAL.** `_ensureTable` (`packages/core/src/database.ts:271-286`)
  takes the `openTable` path whenever a table of that name exists and compares nothing. A
  table created by an older build (extra/missing column, different `dim`) opens happily and
  fails later at write time.
- **"Transactional batch upserts" — MISSING.** Every `upsert*` helper
  (`packages/core/src/database.ts:318-404`) is `await table.add(rows)` — non-atomic, and an
  append, not an upsert. See `issue:file-level-cas-never-written.md` for the consequences.
- **ADR-014 startup validation — PARTIAL.** The check exists but compares
  `embedding.maxVectorUnitTokens` against a hardcoded literal (512) rather than the active
  provider's `maxSeqLength`, so a provider declaring a smaller window initialises anyway and
  the refusal the requirement mandates never fires for the case ADR-014 was written for.
- **`vector_pool` primary key** is declared as a single column where
  `storage-schema.md:74-78` specifies a composite `(chunkHash, unitIndex)` PK. Harmless today
  only because nothing writes a second unit — `unitIndex: 0` is hardcoded
  (`packages/daemon/src/daemon.ts:240`).

Satisfied: connect via Arrow (`database.ts`); all 7 tables created and registered
(`database.ts:137-171`, `vectorPoolDef` `:174-187`); BM25 FTS index on `chunks_pool.text`
(`database.ts:166,291`) and the vector index on `vector_pool.vector`; tested by
`coretest:database.test.ts#lanceDbSchemaSuite` / `#vectorPoolSchemaSuite`.

Remaining: verify an existing table's field list against the definition and fail loudly with
the diff; make the upserts read-then-write (or `merge_insert`); validate against the provider's
own `maxSeqLength`; declare the composite PK.