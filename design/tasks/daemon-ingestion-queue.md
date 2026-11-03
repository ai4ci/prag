---
class: task
id: daemon-ingestion-queue.md
title: Construct thread-safe background queue with Chokidar debouncing
status: done
priority: medium
relates-to:
  - feature:background-worker-queue.md
addressed-by:
  - src:daemon/src/ingestion-queue.ts#IngestionQueue
  - src:daemon/src/ingestion-queue.ts#IngestionConfig
  - src:daemon/src/ingestion-queue.ts#IngestionQueueItem
  - src:daemon/src/ingestion-queue.ts#ProjectIngestionState
tested-by:
  - daemontest:reconcile-window.test.ts#reconcileWindowSuite
  - coretest:transient-errors.test.ts#transientErrorSuite
  - daemontest:ingestion-queue.test.ts#ingestionQueueSuite
  - daemontest:admission-ordering.test.ts
---
## Objective
Construct a thread-safe background ingestion worker queue in `@prag/daemon` with filesystem event debouncing.

## Implementation Details
- Use `chokidar` to monitor registered project directories.
- Implement debouncing logic on file change events.
- Enqueue `IngestionQueueItem` events (URIs, never file content) and dispatch them to the worker pool of ADR-021 -- see `task:ingestion-worker-pool.md`, which owns the thread split and must land first.
- Apply the ADR-023 discovery filters (`ingestion.maxFileBytes`, binary detection) **before** enqueuing, and record skip counters by reason.

## Implementation status

Complete as of 2026-11-03.

- **Cooldown lease — DONE.** `file_mapping.validUntil` is written from
  `cooldownExpiry()`, so the lease survives a restart (ADR-008/ADR-023).
- **Grants gate admission — DONE.** `_checkFile` consults the grants table.
- **Pause — DONE.** Admission reads project status.
- **`close()` — DONE.** Awaits its closers rather than discarding pending work.
- **Dispatch — DONE.** `/sync` is a real drain barrier
  (`task:sync-drain-barrier.md`).
- **Queue identity — DONE.** `dirty` and `cooldowns` are keyed by
  `(projectId, uri)`, not uri alone
  (`issue:ingestion-dirty-set-keyed-by-uri-alone.md`).
- **Admission ordering — DONE.** A denied path is now refused in `_onEvent`,
  before it takes a slot in the dirty set and holds a debounce timer, and the
  `denied` counter increments there so `prag status` can explain the absence.

Only the policy half moved. The content probe (size, empty, binary) stays at
flush deliberately: it is file I/O, debouncing exists to run it once per burst
rather than once per event, and it must see the file as it is when the work
actually runs rather than when the event arrived. ADR-009 §1 is about grants
("a `prag deny` on a secret means prag never reads it"), and that is the part
that had to move.

The gate reads an in-memory grant cache, warmed when a project registers. A
cold or stale cache returns "not known yet" and the file is admitted for the
flush-time check, which remains authoritative -- so the gate can only ever
reject earlier, never admit something previously refused. Both paths are
covered by `daemontest:admission-ordering.test.ts`.

## 2026-11-03: two ways the reconcile walk lost files

`flushAll` reconciles from disk before dispatching, on the principle in its
own comment: "trust the disk, not event delivery". That promise rests on one
stamp per project -- everything with an mtime older than it has been seen.
The stamp lied in two ways, both found while chasing a roughly 1-in-15 suite
flake whose only symptom was that a project indexed nothing at all.

### The window abutted instead of overlapping

The stamp was taken *before* the walk and compared with a strict `>`. A file
written while the walk was in progress therefore has an mtime below the next
`since`, so it is invisible to that reconcile **and to every one after it** --
a permanent loss, undone only by a later edit or an explicit `rescan`. The
same hole swallows a write landing in the same millisecond as the stamp, and
a whole second or two of writes on a filesystem whose mtime granularity is
coarse (many network mounts, and ext3).

Each walk now looks back `RECONCILE_GRACE_MS` (2s) beyond the previous one.
Re-examination is idempotent -- `_ingestFile` short-circuits on the content
hash -- so an overlap costs a stat and a read, never an embed. That makes the
overlap the cheap side of the trade and a lost file the expensive one.

This interacted with the ADR-023 growth breaker: re-examined unchanged files
were counting as growth, so a steady project could have accumulated phantom
growth and held itself. The breaker now counts distinct new content, keyed on
path plus mtime, which is the cheapest "same content" signal available before
the worker computes a hash.

### An incomplete walk still claimed the period

`readdir` failures were swallowed with a bare `continue`, on the stated
assumption that the only cause was permissions, "which the watcher reports as
`denied`". Under load the realistic causes are **EMFILE and ENOMEM** -- file
descriptor or memory exhaustion -- which are transient and report nothing.
The stamp then advanced anyway, so a momentary descriptor shortage skipped a
subtree and put its files permanently behind the window. The same defect
class as above, reached from a different direction.

A walk that could not read part of the tree no longer earns the stamp: the
window stays open and the next drain covers the same period again. `ENOENT`
is excluded, because a directory that has gone really does have nothing to
scan. Non-`ENOENT` `stat` failures count too.

### On testing this

Both tests had to be written around the watcher, and the first attempt at
each passed against the bug:

- Anything that *touches* a file -- a write, or even `utimes` -- makes
  chokidar report it, and the event then satisfies the assertion whether or
  not the reconcile would have. The grace-window test therefore touches
  nothing: it flushes twice with nothing happening in between, which only a
  window that overlaps can satisfy.
- Restoring a directory's mode makes the watcher notice the subtree, so the
  previously unreadable file arrives by event. The assertion that matters is
  on the *other* file, the unchanged one outside the subtree: no event will
  ever mention it again, so only an open scan window can re-offer it.

Both were then checked to fail with each fix reverted.

### A third place, and the flake it probably explains

`_checkFile` wrapped the whole open/stat/read sequence in one `catch` that
recorded `unreadable` and dropped the file. `unreadable` is a final-sounding
reason and nothing retries it -- but under load the error arriving there is
as likely to be `EMFILE` or `ENOMEM` as `EACCES`, and those say "not right
now", not "not ever".

`isTransientFsError` now separates them. A transient failure puts the file
back on the dirty set and counts as **`deferred`**, a reason distinct from
`unreadable` precisely so a reader is not told a file was skipped when it was
only postponed. `EACCES` and friends still skip, because retrying a file the
user deliberately protected would be a loop.

**This is the most likely explanation for the remaining suite flake** --
`keeps the child repo's files out of the parent's ingestion queue` failing
about 1 run in 30 with nothing ingested at all, under a full-suite load that
has several node processes each holding worker threads, inotify instances
and open files. It is *not proven*: the failure did not reproduce in 30 runs
with diagnostics attached, which is itself consistent with a timing-sensitive
resource race but is not evidence. What is proven is the captured line from
one failing run,

```
[prag] ingestion write failed: WorkerPoolError: worker pool is closed
```

which shows a chokidar event arriving after the test had torn its pool down
-- i.e. delivery was late in that run, so the reconcile was the only path
left and it returned nothing.

Recorded rather than closed. If it recurs, the next thing to capture is the
`deferred` counter, which did not exist when it was last seen.
