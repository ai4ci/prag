---
class: issue
id: ingestion-dirty-set-keyed-by-uri-alone.md
title: IngestionQueue.dirty is keyed by uri alone, so two projects watching one file race for ownership
status: resolved
priority: medium
relates-to:
- feature:background-worker-queue.md
---
## Problem

`IngestionQueue._onEvent` stored pending work in `this.dirty`, a map keyed by
the resolved **uri alone**:

```ts
const uri = resolve(filePath);
this.dirty.set(uri, { projectId, uri, eventType });
```

When two registered projects both watched the same file, the second event
overwrote the first. Exactly one ingestion happened, and the `projectId`
recorded against that file was whichever watcher reported **last**. Nothing
orders those watchers, so ownership was decided by timing.

## Resolution

Fixed 2026-11-02. `dirty` and `cooldowns` are keyed by `${projectId}\0${uri}`
(`queueKey`), so each project's view of a file is its own piece of work.
Content-level dedup stays where it is deliberate: `chunks_pool`, on chunk hash
(ADR-002).

Fixing it exposed two further defects on the same path, both fixed here because
the first fix is not observable without them:

1. **`fileVersionId` was the content hash alone.** `storage-schema.md:128`
   specifies `${uri}::${contentHash}`, and `upsertFileMapping` merges on that
   key — so two projects holding byte-identical files shared a primary key and
   ingesting the second **deleted the first**. Sequentially watching two
   projects that each contain the same file left one of them with no row and no
   search results for its own file. The fixture corpus carries
   `alpha/src/shared.ts` and `beta/src/shared.ts` byte-identical to catch
   exactly this; nothing asserted on it.

2. **`mapToFiles` capped the chunk lookup at `chunkHashes.length`.**
   `chunk_mapping` is many-to-one on `chunkHash` by design, so a chunk shared
   by N files has N rows. The 1:1 limit truncated the fan-out and whichever
   rows came back first won, so only one of two projects holding identical
   content could ever appear in results. Now paged until exhausted.

Regression tests: `daemontest:overlapping-projects.test.ts` (the keying),
`daemontest:cross-project-identical-files.test.ts` (the other two). Each was
checked by reverting the corresponding fix and confirming the test fails.

## Not covered

Two projects ingesting the same path now each do their own parse and embed.
That is the intended cost of correct ownership — the duplicate *content* still
dedups in `chunks_pool` — but it is real work, and `watch` still does not warn
when a new root overlaps an existing project.
