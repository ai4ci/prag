---
class: task
id: sync-drain-barrier.md
title: Make POST /sync a true drain barrier
status: done
priority: high
relates-to:
  - feature:test-harness-and-fixtures.md
blocks:
  - task:test-harness-lifecycle.md
tested-by:
  - daemontest:ingestion-e2e.test.ts#daemonWithIngestionSuite
---
## Objective
Define and implement `POST /sync` as a drain barrier so tests can assert on indexed state without racing the ingestion queue (ADR-019). The endpoint already exists; its completion semantics were never specified, and "returns `{ synced: true }`" is not enough to build an assertion on.

## Requirements
- `POST /sync` returns **only once**: the ingestion queue is empty, every URI in the in-memory dirty set has been flushed regardless of its outstanding `validUntil` cooldown lease (ADR-008), every pending debounce window has been forced, and all LanceDB writes are committed and visible to a subsequent read.
- `POST /sync` with `{ projectId }` drains that project only; without it, drains everything.
- Forcing a flush must not leave leases in a state that suppresses the *next* legitimate change event.
- Bound the call: if the queue cannot be drained within a configurable timeout, return an error identifying what is still outstanding rather than hanging or returning success.
- Extend the response from `{ synced: true }` to include what was flushed (e.g. `{ synced: true, flushedFiles: number, pendingFiles: number }`) so a harness failure message can say what did not settle.
- This is also the contract behind `prag sync`, which users invoke for the same reason: "index it now, I am about to search."

## Verification
- Write a file, `POST /sync`, search immediately: the new content is found, with no sleep anywhere in the test.
- Write a file while a long cooldown lease is active, `POST /sync`: the file is indexed despite the lease.
- Run the write/sync/assert cycle several hundred times in a loop with no sleeps and observe zero flakes.

## Implementation status

Done (`15e36b2`). Every requirement verified by `daemontest:ingestion-e2e.test.ts#daemonWithIngestionSuite`.

- **Drain barrier.** `IngestionQueue.flushAll()` (`packages/daemon/src/ingestion-queue.ts:391`)
  dispatches `pool.processFile(...).then(r => this.onFileReady(r))` and awaits it via
  `drain()`; the queue callback returns the write's promise, and `Daemon.trackWrite()`
  (`packages/daemon/src/daemon.ts`) holds it so awaiting implies the LanceDB commit —
  the old callback was `(result) => this._onFileProcessed(result).catch(() => {})`.
- **Per-project + response shape.** `_handleSync` reads `{ projectId }` from the body and
  passes it to `flushAll`/`scanComplete`/`pendingUris`; answers
  `{ ok, flushedFiles, pendingFiles, failedFiles, hadNewFailures }` (200 drained, 202 more
  arriving, 504 on deadline). `flushedFiles` counts what the drain dispatched — counting
  `before - after` reported 0 for a project whose initial scan had queued nothing yet.
- **Bounded.** `withDeadline()` over three phases (initial scan, flush, write) under
  `ingestion.syncTimeoutMs` / `PRAG_SYNC_TIMEOUT_MS` (default 60 s); on expiry, 504
  `SYNC_TIMEOUT` with `pendingFiles` + up to 20 `pendingUris`, exit code 8 in the CLI.
- **Lease forcing.** The drain clears the debounce timers for the target project and
  ingests regardless of `validUntil`; the lease-forcing test uses a 60 s cooldown so it
  can only pass if the flush is truly forced, and asserts a later file still lands.
- **Found while verifying: the drain trusted event delivery.** chokidar is asynchronous,
  so a file written microseconds before `/sync` was invisible to it — and if inotify
  coalesced the event the file stayed unindexed until the next touch. `flushAll()` now
  calls `_reconcile()`, which walks the registered roots and queues anything with
  `mtimeMs` past the last reconciliation. Deletions stay with `prag prune`.
- **Verification.** Sleep-free sync-then-assert (`syncs a project just registered with no
  sleep`), lease forcing, `SYNC_TIMEOUT`, and a write/sync/assert loop — 25 iterations in
  the suite, `PRAG_SYNC_LOOP=300` for the spec's several hundred (each iteration is a
  LanceDB commit, ~1 s). The 1500 ms sleep in this file is gone.

`packages/daemon/test/ingestion-queue.test.ts` still sleeps; those cases test the debounce
window itself, which is a timer under test rather than a race with one.
