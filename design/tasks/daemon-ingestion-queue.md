---
class: task
id: daemon-ingestion-queue.md
title: Construct thread-safe background queue with Chokidar debouncing
status: todo
priority: medium
relates-to:
  - feature://background-worker-queue.md
---
## Objective
Construct a thread-safe background ingestion worker queue in `@prag/daemon` with filesystem event debouncing.

## Implementation Details
- Use `chokidar` to monitor registered project directories.
- Implement debouncing logic on file change events.
- Enqueue `IngestionQueueItem` events to async processing workers without blocking filesystem I/O.