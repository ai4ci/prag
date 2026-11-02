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

Reverted from `done`: watching, debouncing and URI-only queueing work; the ADR-023 filter ordering
does not, and two contract obligations from `feature:background-worker-queue.md:38-48` were never
implemented here or anywhere else.

- **Filters run after enqueue, not before — PARTIAL.** The URI enters the dirty set at
  `packages/daemon/src/ingestion-queue.ts:187` and `_checkFile` runs later, at flush time
  (`:229`, `:258`). A file that will be skipped is therefore queued, occupies a debounce timer, and
  is only rejected when it drains. Counters are recorded
  (`:174-177`, reasons `tooLarge`/`empty`/`binary`/`denied`) but nothing reads them —
  `GET /projects` returns `projectId`/`rootUri`/`status` only (`packages/daemon/src/daemon.ts:383-403`).
- **Cooldown lease never persisted — MISSING.** The feature contract's first step is
  `file_mapping.validUntil = now + cooldown`; the implementation is an in-memory `setTimeout`
  (`ingestion-queue.ts:42,219`) and the column is written as `validUntil: null as Date | null`
  (`daemon.ts:219`). Nothing ever reads it as a lease, so a daemon restart re-indexes every file,
  and `task:sync-drain-barrier.md`'s "flush regardless of outstanding lease" has no lease to bypass.
- **Watcher admission bypasses the grants engine — MISSING.** `_shouldIgnore`
  (`ingestion-queue.ts:127-134`) is a hardcoded basename test. `evaluateUriGrants` is never called
  on this path. Detail: it also does not honour `.gitignore` — the exception is a literal
  `basename !== ".gitignore"` that *allows* the file, not gitignore semantics. See
  `task:project-registry-and-exclusions.md`.
- **Pause not consulted.** `projects.status = 'paused'` is written (`daemon.ts:696-723`) and never
  read by the queue — tracked in `task:ingestion-limits-and-admission.md`.
- **`close()` discards pending work.** `ingestion-queue.ts:100-119` clears the dirty set and timers
  without dispatching, so shutdown loses queued files (relevant to
  `task:daemon-http-server-and-lifecycle.md`'s "clean exit after flushing queues").
- **Dispatch is fire-and-forget** (`:232-237`, `:258-268`) — the reason `/sync` cannot assert
  anything. Owned by `task:sync-drain-barrier.md`.
- `ProjectIngestionState` (`:32`), linked from this task's frontmatter, is referenced nowhere else in
  the repository.

Satisfied: chokidar watches registered project directories (`:64-91`); debouncing with a dirty set
and 60 s default (`:16,181-195,219-245`); items carry URIs never content (`:21-25`) and dispatch to
the ADR-021 pool (`:232-237`).

Remaining: move `_checkFile` ahead of the dirty-set insert; persist the cooldown lease into
`file_mapping.validUntil` and honour it; route admission through `evaluateUriGrants`; check
`paused` before dispatch; flush (or persist) the dirty set on `close()`. Also see
`issue:worker-pool-double-respawn.md` — the pool this queue dispatches to can hang on a dead worker.