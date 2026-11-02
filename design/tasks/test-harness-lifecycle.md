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

Reverted from `done`: scaffolding works (temp root, ephemeral bind, teardown) but the
harness is not the harness the design describes — it neither starts a real daemon
process nor enforces the safety assertions itself.

- **No `daemon.port` file — MISSING.** `grep -rn "daemon.port" packages/*/src` → 0
  matches. The client resolves the port from `PRAG_PORT`/default
  (`packages/cli/src/daemon-client.ts:163`) and re-injects it when spawning (`:270`), so
  the file protocol in requirement 1 does not exist. `PRAG_PORT=0` + in-process usage
  works (`packages/daemon/src/test-harness.ts:57`, `_boundPort` at
  `packages/daemon/src/daemon.ts:106-112`) but nothing outside the process could connect.
- **Managed child with piped stdio — MISSING.** `startTestDaemon` constructs
  `new Daemon(...)` in-process (`test-harness.ts:64-74`); its own comment records the
  shortcut ("no subprocess since no CLI entry point exists yet" — now stale, `prag daemon
  start` exists). No `spawn`/`execFile` of the daemon anywhere in `packages/daemon/src`.
- **No readiness poll, no root assertion inside the harness — MISSING.** `startTestDaemon`
  makes no HTTP call and returns at `test-harness.ts:83`; the `health.root` assertion
  lives in the caller (`packages/daemon/test/test-harness.test.ts:20-23`), so a suite that
  forgets it gets no protection from a destructive call. The only readiness poll is the
  production path (`daemon-client.ts:262-289`), which never checks `status === "ok"`.
- **Environment contract unmet.** The harness sets only `PRAG_ROOT` (`test-harness.ts:71`)
  and restores it on `start()` return (`:76-78`), so nothing downstream inherits it;
  `PRAG_NO_SPAWN` and `PRAG_EMBEDDING_MODEL` are absent from the harness and callers
  hand-assemble env (`packages/cli/test/e2e.test.ts:18-23`); `PRAG_DEBOUNCE_MS` is read by
  **no** code in the repo (`grep -rn PRAG_DEBOUNCE_MS packages/` → 0).
- **Return shape and token.** Returns `{ baseUrl, port, token, root, daemon, schema,
  fixtures }` (`test-harness.ts:21-28,83`) — no `projectPaths`; `token` is the literal
  `"test-token"` (`:56`), never read from `PRAG_API_KEY` or `<root>/state/daemon.token`
  (the daemon writes no token file at all — see `task:test-environment-isolation.md`).
- **Teardown and concurrency — PARTIAL.** `stopTestDaemon` (`:93-110`) closes the
  in-process daemon and `rmSync`s the root, but there is no `POST /shutdown`, no exit wait,
  no `SIGKILL`, and no orphan-process assertion. `:71-78` mutates the process-global
  `process.env.PRAG_ROOT`, so two harnesses in one process race — and no test runs two
  harnesses concurrently (`daemon-isolation.test.ts:37,51` uses fixed `19900+` ports, not 0).

Satisfied: `PRAG_NO_SPAWN=1` in the CLI (`packages/cli/src/main.ts:152-156`, with the
documented message and `ExitCode.NO_DAEMON`) — though no test covers it.

Remaining: spawn the daemon as a managed child with piped stdio, write/read `daemon.port`,
poll `/health` with stderr in the timeout message, move the `health.root` assertion inside
the harness, set the full env contract (or drop `PRAG_DEBOUNCE_MS` from the design — nothing
implements debouncing through it), return `projectPaths`, and add the two parallel-instance
tests.

## Verification
- Two harness instances run in parallel without interfering (distinct ports, distinct roots, both pass).
- A test that throws mid-way still leaves no `prag` process running and no temp directory on disk.
- With `PRAG_NO_SPAWN=1` and no daemon running, a CLI command exits non-zero with the documented message and spawns nothing.
