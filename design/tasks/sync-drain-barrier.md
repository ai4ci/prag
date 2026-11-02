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
