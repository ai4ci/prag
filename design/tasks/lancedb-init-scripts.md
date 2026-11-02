---
class: task
id: lancedb-init-scripts.md
title: Implement LanceDB initialization scripts with 7-table schema setup
status: done
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

- **Schema verification — done, and the reason it matters is worse than "fails later at write
  time".** `_ensureTable` now compares the stored Arrow schema against the definition via
  `schemaDiff`/`typeKey` and refuses to open a table it did not write, naming each differing
  column (`column "vector" is FixedSizeList<4>, want FixedSizeList<8>`) and the remedy.
  Measured on LanceDB 0.41: `add()` into a `FixedSizeList(4)` column **silently truncates** an
  8-element vector to 4 — it only rejects a *short* vector, as a NaN error. So a dimension
  change did not fail loudly at all; it kept accepting writes of wrong embeddings and search
  returned confidently ranked nonsense. `typeKey` derives the identity from `typeId` +
  parameters because `DataType.toString` is a prototype method and does not survive the
  Rust/JS boundary.
- **"Transactional batch upserts" — done as `mergeInsert`, not as a batch.** All seven helpers
  route through one `merge()` (`packages/core/src/database.ts:399`) using
  `whenNotMatchedInsertAll().whenMatchedUpdateAll()`, each on the schema's own key. The
  `table.add()` era ended in `9b3c06e`; this document was stale. Per-key merge rather than one
  Arrow record batch is flagged as a `shortcut:` at the helper.
- **ADR-014 startup validation — done for every production caller.** `validate()` compares
  `maxVectorUnitTokens` against the injected `modelMaxSeqLength`, and
  `packages/daemon/src/main.ts` passes `provider.maxSeqLength` **after** `provider.load()`, so
  the value is the model's real `max_position_embeddings` rather than the
  `KNOWN_MAX_SEQ[…] ?? 512` pre-load guess. `assertVectorUnitBudget` gates before weights are
  fetched. Residual: `config.modelMaxSeqLength ?? 512` still exists as a constructor default
  (now carrying a `shortcut:` comment) — a caller that omits it gets the old behaviour, which
  is why the field is documented as required-in-practice.
- **Composite primary keys — declared.** `TableDefinition.primaryKey` is `string | string[]`
  and `vector_pool` names `["chunkHash","unitIndex"]` per `storage-schema.md:74-78`;
  `branch_mapping` is `["branch","projectId","uri"]` and `chunk_mapping`
  `["fileVersionId","chunkIndex"]`. LanceDB 0.41 has no PK constraint, so this documents
  intent — and the same keys are what the `merge()` calls enforce, which is what makes the
  declaration mean something. The "harmless because nothing writes a second unit" note is
  obsolete: `splitVectorUnits` output is written with a real `unitIndex`
  (`packages/daemon/src/daemon.ts:540-553`).

Satisfied: connect via Arrow (`database.ts`); all 7 tables created and registered
(`database.ts:137-171`, `vectorPoolDef` `:174-187`); BM25 FTS index on `chunks_pool.text`
(`database.ts:166,291`) and the vector index on `vector_pool.vector`; tested by
`coretest:database.test.ts#lanceDbSchemaSuite` / `#vectorPoolSchemaSuite`.

All four items are closed; `packages/core/test/database.test.ts` covers the schema diff and
the ADR-014 gate (`maxVectorUnitTokens: 1024` vs `modelMaxSeqLength: 512` rejects).