---
class: issue
id: shutdown-races-in-flight-ingestion.md
title: Daemon.stop() closes the worker pool while watcher events are still arriving
status: open
priority: medium
relates-to:
  - feature:background-worker-queue.md
---
## Problem
`Daemon.stop()` drains what the queue already holds, then closes the `WorkerPool`. Chokidar's
initial scan keeps delivering `add` events after that drain, so a file discovered during shutdown
is dispatched into a closed pool and its write fails:

```
[prag] ingestion write failed: WorkerPoolError: worker pool is closed
    at WorkerPool.processFile (packages/daemon/src/worker-pool.ts:101:12)
    at IngestionQueue.flushAll (packages/daemon/src/ingestion-queue.ts:503:12)
```

Observed in `packages/daemon/test/ingestion-e2e.test.ts` (the suite that registers several projects
in sequence) and reproduced at `/tmp/load.1.log`–`/tmp/load.6.log` by running
`packages/daemon/test/watch-admission.test.ts` concurrently. It did not fail any assertion in those
runs: the write happens after the test's own `/sync` returned, so the error surfaces only on stderr.
In production the consequence is a file that is on disk, was reported as discovered, and is simply
not in the index after a restart-without-rescan.

Under parallel test load the same fault appears larger: in one recorded run
(`/tmp/daemrun.4.log`) the four `watch admission control` tests that follow the first registration
all failed together, with only the first file of the project indexed — consistent with the pool
being closed while work was still arriving and never being usable again for that daemon. That
cascade did not reproduce in 20 subsequent runs (6 sequential, 6 concurrent, 8 with the full daemon
suite), so it is recorded as a symptom to watch for, not as a reproduced failure.

## Expected Behaviour
Ordering: close the watchers first (chokidar `close()` resolves when no more events will fire),
then drain the queue, then await the writes that drain dispatched, then close the pool. A write
that is refused for shutdown must be recorded as pending rather than logged and forgotten, so the
next start re-indexes it.

## Acceptance Criteria
- A test registers a project, writes N files, and calls `stop()` immediately (no sleeps). It asserts
  the daemon's stderr contains no `worker pool is closed`, and that a fresh daemon over the same
  index finds all N files.
- `stop()` returns only after every dispatched write has settled, and any write that could not be
  dispatched is visible in a subsequent `/health` `ingestion.pendingFiles`.

## Related
`task:sync-drain-barrier.md` made `/sync` a real barrier for the *caller*; this is the same
un-awaited-promise class of bug on the shutdown path (`Daemon.stop()` vs
`IngestionQueue.close()`, which awaits `drain()` but not the pool close).
