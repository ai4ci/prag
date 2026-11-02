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

## Implementation status

Complete as of 2026-11-02.

- **`PRAG_PORT=0` — DONE.** It had never worked: `loadConfig` used
  `Number(process.env.PRAG_PORT) || config.server?.port || DEFAULT_PORT`, and
  `0` is falsy, so every daemon silently took the fixed 7724 and two could not
  run at once. Now `readIntEnv("PRAG_PORT") ?? ...`, the helper that already
  existed beside it for exactly this distinction.
- **`daemon.port` — DONE.** Written by `writeRuntimeFiles()`; the harness reads
  the bound port from it rather than guessing, which is the documented client
  path (ADR-016).
- **`PRAG_NO_SPAWN` — DONE.** Honoured by the CLI, set for the spawned child,
  and exercised in `clitest:subprocess-e2e.test.ts`.
- **Managed child with piped stdio — DONE.** `spawn` is the harness default: a
  non-detached child started exactly as `prag daemon start` starts one, with
  stdout and stderr captured so a boot failure appears in the test output
  instead of as a timeout. An earlier note here claimed this was blocked by the
  sandbox's subprocess networking isolation. That was wrong — spawning works
  there; the real blocker was the `PRAG_PORT=0` bug above, which made every
  concurrent spawn collide on 7724.
- **`in-process` mode — DONE, opt-in.** Still available per call
  (`startTestDaemon({ mode: "in-process" })`) and for a whole run via
  `PRAG_TEST_MODE=in-process`. Two tests need it because they hold the `Daemon`
  or `LanceDbSchema` object directly; those fields are now optional on
  `TestDaemonInstance`, so reaching for them without asking for the mode is a
  type error rather than a runtime surprise.
- **Readiness poll — DONE.** Both modes poll `GET /health` before returning,
  bounded, and the spawn path fails with the child's own output attached.
- **Root assertion — DONE.** The harness refuses to return a daemon whose
  `health.root` is not this test's temp root and kills it. A test proceeding
  against a real `~/.local/share/prag` can delete the developer's index.
- **Concurrency safety — DONE.** No `process.env` mutation: paths go through
  `DaemonConfig.paths` in-process, and through the child's own env when
  spawned. Three harnesses start concurrently with distinct roots and ports in
  `daemontest:test-harness.test.ts`.
- **Teardown — DONE.** Unconditional: `POST /shutdown`, wait for exit with a
  5s bound, `SIGKILL` on timeout, then `rm -rf` the root. Asserted by probing
  the pid with signal 0 after teardown.

CI runs the default (spawn). `PRAG_TEST_MODE=in-process` is for a machine that
cannot route loopback to a child.

See `issue:daemon-suite-flaky-under-parallel-execution.md`: the intermittent
failures that prompted this work were a Node bug (nodejs/node#63323, fixed in
24.19.0), not a harness defect.
