---
class: issue
id: worker-pool-double-respawn.md
title: WorkerPool respawns twice per crash and leaves a dead worker index in the idle list, so a request can hang forever
status: resolved
priority: high
relates-to:
  - feature:background-worker-queue.md
blocks:
  - task:ingestion-worker-pool.md
---
## Problem
`packages/daemon/src/worker-pool.ts` grows one worker per crash instead of replacing it, and
after a crash it can hand work to a terminated worker whose promise never settles.

Two independent defects in `_spawn`:

**1. Double respawn.** Node emits `"error"` for a thrown worker fault and then `"exit"` with a
non-zero code. Both handlers respawn (`packages/daemon/src/worker-pool.ts:157-163` and
`:165-169`):

```ts
worker.on("error", (err) => { ...; this._spawn(script); });   // respawn replacement
worker.on("exit", (code) => { if (code !== 0) this._spawn(script); });
```

One crash → two new workers. A deterministically crashing file (a grammar that throws on a
particular construct) therefore doubles the pool on every retry, unbounded. ADR-021's whole
point is bounding ingestion concurrency and memory, so this is the failure the ADR exists to
prevent, triggered by the error path meant to contain it.

**2. Stale idle index.** `_spawn` pushes the new worker at `this.workers.length` and marks that
index idle (`:171`), while the crashed index is never removed from `this.idle`. If the crashed
worker was idle at the time (the common case — crashes during idle scanning, or the exit path
after the message resolved), `idle` now holds both the dead index and the live one.
`processFile` pops from that list (`:73-77`) and `_dispatch` posts to
`this.workers[deadIdx].postMessage(...)` (`:116`) — a terminated `Worker`. The `pending` entry is
set, no `"message"` ever arrives, and the returned promise never resolves or rejects.

Downstream, `IngestionQueue` awaits that promise (or fires it un-awaited —
`packages/daemon/src/ingestion-queue.ts:232-237,258-268`), so the dirty-set entry is lost and
`POST /sync` — which does not await the chain in the first place — reports success while the file
is silently never indexed.

## Expected Behaviour
- One respawn per death. Track the index being replaced, and respawn from a single place (e.g.
  on `"exit"` only, treating `"error"` as notification-only), or guard with a per-index flag.
- Remove the dead index from `idle` and `pending` before spawning the replacement; never dispatch
  to an index whose worker has exited.
- A dispatch to a dead worker must reject, not hang — hold the pending promise and reject it on
  `"exit"` while pending.
- The file being processed at crash time is marked errored per the task requirement, not dropped
  (currently `errored` has no match anywhere in `packages/daemon/src`; `file_mapping` has no
  status column, `packages/core/src/database.ts:83-91`).

## Acceptance Criteria
- A test posts to a worker that throws, then asserts `pool.workerCount` is unchanged (currently it
  becomes size+1) and that `processFile` for a subsequent file resolves within a bounded time
  rather than hanging.
- A test kills a worker mid-parse and asserts the daemon still answers `/health` and the affected
  URI is reported as errored — this is Verification item 4 of `task:ingestion-worker-pool.md`,
  which has no test today (`grep "kill|terminate|respawn" packages/daemon/test/` → no match).
- Repeated crashes (10 injected) do not grow the pool.

## Related
`task:ingestion-worker-pool.md` claims containment works. The unbounded-growth symptom is distinct
from `issue:file-level-cas-never-written.md` (mapping-row growth) and
`issue:chunk-pool-disk-usage-growth.md` (pool retention).

## Resolution (2026-11-02, branch `mvp`)
Fixed in `packages/daemon/src/worker-pool.ts`. Respawn is now guarded so `error` and `exit` cannot
both fire it (handler checks `if (worker !== entry.worker) return;` and clears the slot before
spawning), and the pool tracks live workers so a dead one is never dispatched to. `ProcessResult`
gained `contentHash` (sha256 of raw bytes), which the content-addressable ingestion path needs.
Covered by `daemontest:worker-pool.test.ts#workerPoolSuite`.
