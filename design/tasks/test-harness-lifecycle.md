---
class: task
id: test-harness-lifecycle.md
title: Implement test harness setup/teardown with ephemeral port and no-spawn mode
status: done
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

## Verification
- Two harness instances run in parallel without interfering (distinct ports, distinct roots, both pass).
- A test that throws mid-way still leaves no `prag` process running and no temp directory on disk.
- With `PRAG_NO_SPAWN=1` and no daemon running, a CLI command exits non-zero with the documented message and spawns nothing.
