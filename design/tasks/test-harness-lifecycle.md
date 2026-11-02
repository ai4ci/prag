---
class: task
id: test-harness-lifecycle.md
title: Implement test harness setup/teardown with ephemeral port and no-spawn mode
status: in_progress
priority: high
relates-to:
  - feature:test-harness-and-fixtures.md
addressed-by:
  - src:daemon/src/test-harness.ts#startTestDaemon
  - src:daemon/src/test-harness.ts#stopTestDaemon
  - src:daemon/src/test-harness.ts#TestDaemonInstance
tested-by:
  - daemontest:test-harness.test.ts#testHarnessSuite
---
## Objective
Provide the shared setup/teardown harness every test suite uses, plus the two daemon-lifecycle controls it depends on (ADR-019).

## Requirements
### Daemon/CLI controls
- `PRAG_PORT=0`: bind a kernel-assigned ephemeral port and write the actual bound port to `daemon.port`. Clients read the port from `daemon.port` whenever `PRAG_PORT` is `0` or unset-with-a-running-daemon. This does not reintroduce port scanning (ADR-016) — the port is read from a known file, never guessed.
- `PRAG_NO_SPAWN=1`: the CLI must not lazily auto-spawn a daemon. It fails immediately with "no daemon running and PRAG_NO_SPAWN is set". Prevents a crashed test from leaving an orphaned `detached: true` daemon holding a port and a temp directory.

### Harness
- Expose `startTestDaemon()` / `stopTestDaemon()` helpers that:
  1. `mkdtemp` a root and set `PRAG_ROOT`, `PRAG_PORT=0`, `PRAG_NO_SPAWN=1`, `PRAG_EMBEDDING_MODEL=fake:384`, `PRAG_DEBOUNCE_MS=0` and `defaults.localCooldownSeconds=0` unless a test overrides them;
  2. start `@prag/daemon` as a managed (not detached) child with piped stdio so failures surface in test output;
  3. poll `GET /health` until `status: "ok"`, with a bounded timeout and the daemon's captured stderr included in the timeout failure message;
  4. **assert `health.root` is the temp root before returning** — abort the test run loudly if not, since the next call may be destructive;
  5. return `{ baseUrl, token, root, projectPaths }` with the token read from `PRAG_API_KEY` or `<root>/state/daemon.token`.
- Teardown runs unconditionally, including after a failed test: `POST /shutdown`, wait for process exit with a timeout, `SIGKILL` on timeout, then `rm -rf` the root. Never leave a process or a directory behind.
- Harness must be safe to run concurrently: no shared port, path, or global state between instances.

## Implementation status

Still `in_progress`. Updated 2026-11-02.

- **`daemon.port` file — DONE.** Written by `writeRuntimeFiles()`
  (`daemon/src/main.ts:275`); the CLI reads the port with the documented
  precedence (`PRAG_PORT` -> `server.port` -> 7724).
- **`PRAG_NO_SPAWN` — DONE.** Honoured by the CLI and exercised against a real
  spawned daemon in `clitest:subprocess-e2e.test.ts`.
- **Readiness poll — DONE.** `startTestDaemon` polls `GET /health` until the
  daemon answers `ok`, with a bounded timeout whose failure names the last
  response. A test's first request is no longer a race.
- **Root assertion — DONE.** The harness refuses to return a daemon whose
  `health.root` is not the temp root, and takes it down on the way out. This is
  requirement 4 and the reason it exists: a test that proceeds against a real
  `~/.local/share/prag` can delete the developer's index.
- **Concurrency safety — DONE.** Paths are passed explicitly through
  `DaemonConfig.paths` instead of `process.env.PRAG_ROOT`. The previous version
  set the variable, awaited `daemon.start()` (which yields) and restored
  afterwards, so two overlapping starts could restore over each other --
  `process.env` is exactly the "global state between instances" the
  requirement forbids.

Outstanding:

- **Managed child with piped stdio — MISSING, and environment-constrained.**
  `startTestDaemon` still constructs `new Daemon(...)` in-process. The stale
  reason ("no CLI entry point exists yet") is gone -- `prag daemon start`
  works -- but a real constraint replaced it: this project is developed in a
  sandbox that isolates subprocess networking, which is why
  `clitest:subprocess-e2e.test.ts` is the single spawning test and needs a
  forwarded port. Switching the default harness to spawning would break the
  suite in that environment. The realistic shape is an opt-in spawn mode, kept
  green in CI, with in-process as the default; that is a decision about how the
  project is developed, not a refactor, so it is recorded rather than taken.
- **Environment contract — PARTIAL.** The daemon is configured directly
  (root, port, token, `fake:<dim>` embedder), which is stronger than setting
  environment variables for an in-process daemon. The variables the
  requirement lists (`PRAG_PORT=0`, `PRAG_NO_SPAWN=1`,
  `PRAG_EMBEDDING_MODEL=fake:384`, `PRAG_DEBOUNCE_MS=0`) only become meaningful
  once there is a child process to set them for, so this closes with the item
  above.

See `issue:daemon-suite-flaky-under-parallel-execution.md`: the intermittent
file-level failures that prompted this work were a Node bug
(nodejs/node#63323, fixed in 24.19.0), not a harness defect. The harness was
suspected and exonerated.
