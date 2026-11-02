---
class: task
id: sync-drain-barrier.md
title: Make POST /sync a true drain barrier
status: in_progress
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

Reverted from `done`: `/sync` returns before any work is written, so nothing downstream
can assert indexed state without sleeping.

- **Not a drain barrier.** `IngestionQueue.flushAll()` (`packages/daemon/src/ingestion-queue.ts:248-271`)
  clears timers and the dirty map, then dispatches
  `this.pool.processFile(...).then(r => this.onFileReady(r))` **without awaiting** the
  promise. The consuming callback is fire-and-forget too —
  `(result) => this._onFileProcessed(result).catch(() => {})` (`packages/daemon/src/daemon.ts:97-100`)
  — so even an awaited `processFile` would not imply the LanceDB write happened.
  `flushAll()` resolves while ingestion is still in flight.
- **Response shape unmet.** `/sync` answers `{ ok: true }` (`packages/daemon/src/daemon.ts:471-472`).
  No `flushedFiles`/`pendingFiles`, although the CLI already prints both when present
  (`packages/cli/src/main.ts:294-299`) — the client and CLI are coded for a contract the
  server never sends.
- **No timeout, no per-project drain, no lease forcing.** `_handleSync(_req, res)`
  ignores the request body, so `{ projectId }` is discarded; there is no `SYNC_TIMEOUT`
  path (`grep SYNC_TIMEOUT packages/` → 0), and no attempt to bypass an outstanding
  `validUntil` lease — `validUntil` is never written (always `null`,
  `packages/daemon/src/daemon.ts:218`).
- **Verification inverted.** No test does a sleep-free sync-then-assert. The only test
  that both syncs and asserts indexed state sleeps first: write at
  `packages/daemon/test/ingestion-e2e.test.ts:62-66`, `await sleep(1500)` at `:70`, sync
  at `:73-77`, assert at `:79-101`. `packages/cli/test/daemon-client.test.ts:75-78` calls
  `sync()` only to assert `result.ok`, on a harness where ingestion is disabled and
  `/sync` short-circuits (`daemon.ts:464-467`). `packages/daemon/test/ingestion-queue.test.ts`
  contains 19 compensating sleeps (100-500 ms each).

Remaining: await the dispatched chain end-to-end (return the promise from the queue
callback and await `_onFileProcessed`), report flushed/pending counts, add the per-project
body parameter and a bounded timeout with `SYNC_TIMEOUT`, then delete the sleeps from
`ingestion-e2e.test.ts` and use sync-then-assert there.
