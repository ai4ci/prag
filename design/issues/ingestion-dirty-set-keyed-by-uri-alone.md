---
class: issue
id: ingestion-dirty-set-keyed-by-uri-alone.md
title: IngestionQueue.dirty is keyed by uri alone, so two projects watching one file race for ownership
status: open
priority: medium
relates-to:
- feature:background-worker-queue.md
---
## Problem

`IngestionQueue._onEvent` (`packages/daemon/src/ingestion-queue.ts`) stores
pending work in `this.dirty`, a map keyed by the resolved **uri alone**:

```ts
const uri = resolve(filePath);
this.dirty.set(uri, { projectId, uri, eventType });
```

When two registered projects both watch the same file, the second event
overwrites the first. Exactly one ingestion happens — which is correct — but the
`projectId` recorded against that file is whichever watcher reported **last**.
Nothing orders those watchers, so ownership is decided by event timing.

## Why it matters

`file_mapping` is keyed by uri as well, so the duplication is invisible
downstream: one row, one owner, no error. A file can therefore be attributed to
a different project between two runs of the same daemon, and a `search-local`
scoped to the project that *should* own it silently returns nothing.

This also makes the condition hard to test. A test asserting "project A did not
ingest B's file" passes whether or not any exclusion is in place, because the
overwrite collapses the two paths either way — the assertion has to be made on
a queue with only one project registered to mean anything.

## Current scope

`task:project-registry-and-exclusions.md` removed the common case: a nested git
repository is excluded from its parent's watcher and its parent's reconcile
walk, so parent/child no longer contend for the same file. The race remains for
any other overlap — most obviously two `prag watch` roots where one contains the
other, which nothing currently prevents.

## Possible fix

Key `dirty` (and the cooldown map that shadows it) by `projectId` + uri rather
than uri alone, so each project's view of a file is its own. That makes
double-ingestion visible rather than silently collapsed, which is the point:
the dedup should happen in `chunks_pool` on content hash (ADR-002), where it is
deliberate, not accidentally in the queue's bookkeeping.

Alternatively, refuse at `watch` time to register a root that overlaps an
existing project, which is narrower but makes the constraint explicit.
