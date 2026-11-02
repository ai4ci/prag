---
class: issue
id: file-level-cas-never-written.md
title: Ingestion writes a random fileVersionId and empty contentHash, and the upsert helpers append, so nothing is content-addressable or deduplicated
status: resolved
priority: high
relates-to:
  - feature:git-branch-awareness.md
blocks:
  - task:branch-mapping-and-pruning.md
---
## Problem
The whole storage model is content-addressable. ADR-002 defines
`file_mapping.fileVersionId = ${uri}::${contentHash}`, `storage-schema.md:54,58,128,132`
specifies `contentHash` as a deterministic hash of the complete content and the PK format,
and ADR-010 makes the hash whitespace-invariant so a reformat produces no new storage.
None of that is written today.

`Daemon._ingestFile` — `packages/daemon/src/daemon.ts:214-221`:

```ts
const fileVersionId = crypto.randomUUID();
const fmRow = {
  fileVersionId,
  projectId: result.projectId,
  uri: result.filePath,
  validUntil: null as Date | null,
  contentHash: "",
  language: result.language,
};
```

- `contentHash: ""` — there is no `createHash` import anywhere in `packages/daemon/src`.
- `fileVersionId` is random, so every file event mints a **new** file version, even for
  byte-identical content.

Compounding this, the persistence helpers are blind appends: each body of
`upsertFileMapping` / `upsertChunksPool` / `upsertVectorPool` / `upsertBranchMapping` in
`packages/core/src/database.ts:326-397` is `await table.add(rows)`, with the shortcut
comment `// shortcut: naive per-row insert via add` at `:320-321`. Nothing reads before
writing, so an unchanged file re-indexed ten times yields ten `file_mapping` rows and ten
copies of every chunk mapping.

## Consequences
- **Unbounded growth.** Re-saving a file without changing it (a formatter touch, a `git
  checkout` away and back, a spurious editor event) adds rows forever. This is the same
  symptom `issue:chunk-pool-disk-usage-growth.md` describes, but at the mapping layer, where
  no manual GC path reaches it.
- **Cross-project and cross-branch dedup does not happen.** `test/fixtures/README.md:11`
  claims "the same content indexed from two projects shares one `chunks_pool`" — false: the
  *pool* row is hash-keyed but the mapping rows accumulate per random version id, and
  `file_mapping` never shares at all. `feature:git-branch-awareness.md:30,35` ("files whose
  content matches an existing `contentHash` produce no new storage writes") is unimplementable
  while `contentHash` is empty.
- **Branch switching cannot be cheap.** The zero-reparse design depends on recognising an
  existing content hash; with an empty hash there is nothing to compare, so every checkout is
  a full re-parse and re-embed.
- **Web refresh cannot detect change.** `feature:web-and-nonlocal-content.md:70` and ADR-024
  both say "re-fetch and write only when `contentHash` changed". With an empty column that
  comparison always looks like a change.
- **`validUntil` is dead**, always `null` at `daemon.ts:218`, so ADR-008's expiry-driven
  refresh scan (`validUntil IS NOT NULL AND validUntil <= now()`) selects nothing — and
  `sync-drain-barrier`'s "flush regardless of outstanding lease" requirement has no lease to
  bypass.

Chunk-level hashing *is* real (`packages/core/src/chunker.ts:95-99`, sha256 over
normalized content), which is why the bug is easy to miss: search dedup at the chunk layer
partly masks the mapping-layer duplication.

## Expected Behaviour
- `contentHash` is a deterministic hash of the complete indexed content, computed once per
  file, per ADR-010's normalization so whitespace-only edits do not change it.
- `fileVersionId` is `${uri}::${contentHash}` — stable across events, so re-ingesting
  unchanged content is a no-op.
- The `upsert*` helpers become real upserts (read-then-write, or LanceDB
  `merge_insert`/`update` where available), and the `shortcut:` comment at
  `packages/core/src/database.ts:320-321` is removed. The read-then-write window must be
  closed by the ingestion pause that `task:branch-mapping-and-pruning.md` already mandates
  around sweeps.
- `validUntil` is populated from the applicable cooldown lease so expiry-driven refresh has
  something to select.

## Acceptance Criteria
- Indexing the same file 5 times (touch, no content change) leaves exactly one
  `file_mapping` row and one `chunk_mapping` row per chunk.
- `corpus/alpha/src/shared.ts` and `corpus/beta/src/shared.ts` (byte-identical fixtures)
  produce one `chunks_pool` row **and** identical non-empty `contentHash` values in both
  projects' `file_mapping` rows.
- Reformatting `reformat/original.ts` into `reformatted.ts` changes no hash.
- A test asserts row counts by querying the tables directly, not via search results.

## Related
Blocks `task:branch-mapping-and-pruning.md`, whose branch-pointer copy step is meaningless
until a version id is stable. Distinct from
`issue:unlink-prune-deletes-shared-pool-rows.md` (deletion of shared rows) — that one is
about destroying shared content, this one about failing to create the sharing.

## Resolution (2026-11-02, branch `mvp`)
Fixed. The ingestion worker computes `contentHash = sha256(rawBytes)` and returns it, and
`_ingestFile` uses it **as** the `fileVersionId`, so an unchanged file re-reported by the watcher
resolves to the same row: it refreshes `file_mapping.validUntil` and returns without re-embedding.
When content changes, the superseded version's `file_mapping`/`chunk_mapping` rows are deleted (pool
rows left for the GC sweep). All seven `upsert*` helpers in `packages/core/src/database.ts` went
from `table.add(rows)` to `mergeInsert(...).whenNotMatchedInsertAll().whenMatchedUpdateAll()` via a
local `merge()` helper, so they are idempotent — composite keys: `["projectId","branch","uri"]`,
`fileVersionId`, `["fileVersionId","chunkIndex"]`, `chunkHash` (insert-only),
`["chunkHash","unitIndex"]`. Verified against LanceDB 0.41 with a throwaway probe (composite-key
merge on a single-primaryKey table: 2 rows after 2 merges).
