---
class: task
id: daemon-ingestion-queue.md
title: Construct thread-safe background queue with Chokidar debouncing
status: in_progress
priority: medium
relates-to:
  - feature:background-worker-queue.md
addressed-by:
  - src:daemon/src/ingestion-queue.ts#IngestionQueue
  - src:daemon/src/ingestion-queue.ts#IngestionConfig
  - src:daemon/src/ingestion-queue.ts#IngestionQueueItem
  - src:daemon/src/ingestion-queue.ts#ProjectIngestionState
tested-by:
  - daemontest:ingestion-queue.test.ts#ingestionQueueSuite
---
## Objective
Construct a thread-safe background ingestion worker queue in `@prag/daemon` with filesystem event debouncing.

## Implementation Details
- Use `chokidar` to monitor registered project directories.
- Implement debouncing logic on file change events.
- Enqueue `IngestionQueueItem` events (URIs, never file content) and dispatch them to the worker pool of ADR-021 -- see `task:ingestion-worker-pool.md`, which owns the thread split and must land first.
- Apply the ADR-023 discovery filters (`ingestion.maxFileBytes`, binary detection) **before** enqueuing, and record skip counters by reason.

## Implementation status

Re-audited 2026-11-02. Still `in_progress`; most of the previous audit is now stale.

- **Cooldown lease — DONE.** `file_mapping.validUntil` is written from
  `cooldownExpiry()` (`daemon.ts:554,606`) rather than left null, so the lease
  survives a restart (ADR-008/ADR-023).
- **Grants gate admission — DONE.** `_checkFile` consults the grants table, so
  the watcher no longer bypasses the engine.
- **Pause — DONE.** Admission reads project status.
- **`close()` — DONE.** Awaits its closers (`ingestion-queue.ts:227`) instead of
  discarding pending work.
- **Dispatch — DONE.** `/sync` is a real drain barrier; see
  `task:sync-drain-barrier.md`.

Outstanding:

- **Filters run after enqueue, not before — PARTIAL.** `_checkFile` is called at
  flush time (`ingestion-queue.ts:493,557`), so a file that will be skipped is
  still queued and holds a debounce timer until it drains. Efficiency and
  accounting, not correctness: the file is still filtered before any work.
