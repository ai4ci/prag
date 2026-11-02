---
class: issue
id: daemon-entry-point-has-no-main.md
title: packages/daemon has no executable entry point — lazy spawn and prag daemon start can never succeed
status: resolved
priority: high
relates-to:
  - feature:dual-interfaces.md
blocks:
  - task:test-harness-lifecycle.md
---
## Problem
`@prag/daemon` exposes no runnable entry point. `packages/daemon/src/index.ts` is three
`export` lines; `packages/daemon/src/daemon.ts` ends with the `readBody()` helper and has no
main block — `grep -n "import.meta.main|process.argv|new Daemon(|.start(" packages/daemon/src/daemon.ts`
matches nothing outside the class body.

Verified:

```
$ timeout 12 node --import tsx packages/daemon/src/daemon.ts
exit=0    # exits immediately, binds nothing
```

The CLI spawns exactly that file (`packages/cli/src/daemon-client.ts:258-272` →
`--import tsx packages/daemon/src/daemon.ts`, `stdio: "ignore"`, `detached: true`) and then
polls `/health` for 5 s (`:275-289`) before throwing `NO_DAEMON`. So:

- `prag daemon start` (`packages/cli/src/main.ts:92-103`) always fails with
  "Could not start daemon — timed out waiting for /health to respond."
- Lazy startup on first query (requirement 2 of `task:cli-read-only-search.md`, ADR-016's
  documented spawn-then-poll flow) can never succeed for a real user.
- Because stdio is `ignore`, there is no output explaining why — the failure is a timeout.

Every passing test hides this: the harness constructs `new Daemon(...)` in-process
(`packages/daemon/src/test-harness.ts:64-74`) and never spawns, so nothing in the suite has
ever executed the path a real user takes. The embedding provider also has no production
construction site — `getProvider()` (`packages/core/src/embedding.ts:136`) is called only
from tests; the daemon takes an `embedder` argument (`daemon.ts:90`) and only the harness
supplies one (`new FakeEmbeddingProvider(dim)`, `test-harness.ts:77`).

## Expected Behaviour
An entry point that reads config (`loadConfig` / `loadPragConfig`), resolves the embedding
provider from `embedding.model` / `PRAG_EMBEDDING_MODEL` via `getProvider()`, opens the
schema, constructs `Daemon`, calls `start()`, and handles `SIGINT`/`SIGTERM` by stopping
cleanly. `packages/cli` spawns that file; `packages/daemon/package.json` names it in `bin`
or `exports`. The daemon's `version`/`port` values it reports must come from the same sources
the health contract advertises (currently `version: "0.1.0"` is a literal at `daemon.ts:328`
and `port` reports the *configured* port, not `_boundPort`, so a `PRAG_PORT=0` daemon would
report port 0).

## Acceptance Criteria
- `node --import tsx packages/daemon/src/daemon.ts` with `PRAG_ROOT=<tmp>` binds, writes a
  token, and answers `GET /health` with the temp root.
- `prag daemon start` against a clean environment succeeds and `prag daemon stop` stops it.
- One CLI-level test spawns the real entry point instead of relying on the in-process daemon
  (`PRAG_NO_SPAWN=1` keeps the rest of the suite hermetic).
- `PRAG_EMBEDDING_MODEL` selects the provider in the spawned process, asserted by health or by
  vector dimensionality, not by a unit test of `getProvider`.

## Related
Blocks `task:test-harness-lifecycle.md`, whose requirements 2 and 3 (managed child with piped
stdio, `/health` poll with captured stderr) are unimplementable until something is spawnable.
Overlaps `issue:no-installation-instructions.md` (packaging, `bin`, `private: true`) — fix the
entry point first, packaging second.

## Resolution (2026-11-02, branch `mvp`)
Fixed. `packages/daemon/src/main.ts` is the entry point: `loadConfig()` (PRAG_PORT / PRAG_API_KEY /
PRAG_EMBEDDING_MODEL / PRAG_WORKER_POOL_SIZE + config.ingestion), `bootstrap()` (provider load,
vector-unit budget assert, `.embedding-model.json` sidecar mismatch check, schema init),
`writeRuntimeFiles()` (creates runDir, writes `daemon.port` always and `daemon.token` 0600 when the
token is the `guest` default), `main()` with SIGINT/SIGTERM drain and a `degraded` daemon on model
mismatch. `packages/cli/bin/prag.mjs` registers the tsx loader; `packages/daemon/src/index.ts`
re-exports `loadConfig` from main.ts. Health now reports `version: DAEMON_VERSION` and
`port: this._boundPort ?? config.port`.
Acceptance criteria: entry point binds + answers /health (verified by hand and by
`cli:subprocess-e2e.test.ts`); `prag daemon start`/`stop` work from a clean PRAG_ROOT; the CLI test
spawns the real entry point; `PRAG_EMBEDDING_MODEL` is asserted through `/health` in the spawned
process (`fake:8` reported in health).
