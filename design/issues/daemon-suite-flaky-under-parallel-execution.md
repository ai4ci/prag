---
class: issue
id: daemon-suite-flaky-under-parallel-execution.md
title: Daemon test files fail intermittently at file level under parallel execution
status: open
priority: medium
relates-to:
- feature:test-harness-and-fixtures.md
---
## Problem

Running the daemon suite repeatedly, roughly one run in five fails with a
**file-level** error and no named subtest:

```
✖ packages/daemon/test/ingestion-queue.test.ts (5589.198332ms)
✖ failing tests:
✖ packages/daemon/test/ingestion-queue.test.ts (5589.198332ms)
```

The file varies between runs — `ingestion-queue.test.ts` and
`error-envelope.test.ts` have both been seen. Each file passes consistently
when run on its own; the failure only appears when the node test runner
executes several files in parallel.

## Confirmed pre-existing

Reproduced on a clean worktree at `ac84a56` with no uncommitted changes, 5
runs to first failure. It is **not** caused by the test files added around it,
though more files in the package make a given run likelier to hit it.

## Why it matters

CI has been passing, which means it has been passing by luck: a single
`npm test` has roughly a 1-in-5 chance of a spurious red. That trains everyone
to re-run rather than read a failure, which is how a real regression gets
waved through.

It also makes "all tests pass" a weaker statement than it looks, both for a
developer and for anything automated that gates on the suite.

## Where to look

The absence of a named subtest points at the file's own lifecycle rather than
an assertion: a `before`/`after` hook timing out, a daemon or worker pool not
releasing, or the runner's per-file timeout being hit under contention. Several
files start daemons and `WorkerPool`s concurrently and share one machine's
event loop.

Worth checking first:

- Whether the failing file is the one that happened to start last, i.e. whether
  this is simply the runner's default timeout under load.
- `WorkerPool` and chokidar handle release in teardown: `ingestion-queue.test.ts`
  already carries a `setImmediate` hop in `afterEach` "to allow chokidar's
  native fs.watch handle to release", which suggests this has been felt before.
- Running the daemon package with `--test-concurrency=1` to confirm the
  diagnosis before changing anything.
