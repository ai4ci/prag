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

Re-audited 2026-11-02. Still `in_progress`: the harness works and every suite depends
on it, but it is not the harness the design describes.

- **`daemon.port` file — DONE.** Written by `writeRuntimeFiles()`
  (`daemon/src/main.ts:275`), and the CLI reads the daemon's port with the
  documented precedence (`PRAG_PORT` → `server.port` → 7724).
- **`PRAG_NO_SPAWN` — DONE.** Honoured by the CLI, and
  `cli/test/subprocess-e2e.test.ts` drives a real spawned daemon through it.

Outstanding:

- **Managed child with piped stdio — MISSING.** `startTestDaemon` constructs
  `new Daemon(...)` in-process (`test-harness.ts:73`). Its own comment ("no CLI
  entry point exists yet") is stale — `prag daemon start` works. In-process is
  partly deliberate here: the sandbox isolates subprocess networking, which is
  why `subprocess-e2e.test.ts` is the single exception and needs a forwarded
  port. Revisit together with that constraint rather than in isolation.
- **No readiness poll or root assertion inside the harness — MISSING.** The
  requirement is that the harness itself aborts loudly when `health.root` is not
  the temp root, since the next call may be destructive.
- **Environment contract unmet.** The harness sets `PRAG_ROOT` only; the design
  calls for `PRAG_PORT=0`, `PRAG_NO_SPAWN=1`, `PRAG_EMBEDDING_MODEL=fake:384`
  and `PRAG_DEBOUNCE_MS=0` unless a test overrides them.
