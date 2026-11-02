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
  - src:daemon/src/ingestion-queue.test.ts
  - src:daemon/src/ingestion-queue.ts#IngestionQueueItem
  - src:daemon/src/ingestion-queue.ts#ProjectIngestionState
---
## Objective
Construct a thread-safe background ingestion worker queue in `@prag/daemon` with filesystem event debouncing.

## Implementation Details
- Use `chokidar` to monitor registered project directories.
- Implement debouncing logic on file change events.
- Enqueue `IngestionQueueItem` events (URIs, never file content) and dispatch them to the worker pool of ADR-021 -- see `task:ingestion-worker-pool.md`, which owns the thread split and must land first.
- Apply the ADR-023 discovery filters (`ingestion.maxFileBytes`, binary detection) **before** enqueuing, and record skip counters by reason.