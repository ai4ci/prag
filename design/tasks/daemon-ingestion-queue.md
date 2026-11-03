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
