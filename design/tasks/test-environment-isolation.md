---
class: task
id: test-environment-isolation.md
title: Implement PRAG_ROOT isolation and assertable resolved paths
status: done
priority: high
relates-to:
  - feature:test-harness-and-fixtures.md
blocks:
  - task:test-harness-lifecycle.md
  - task:test-fixture-corpus.md
  - task:deterministic-embedding-provider.md
addressed-by:
  - src:core/src/paths.ts#resolvePragPaths
  - src:core/src/paths.ts#ensurePragDirs
  - src:core/src/paths.ts#PragPaths
  - src:core/src/paths.ts#PragConfig
  - src:core/src/paths.ts#loadPragConfig
  - src:daemon/src/main.ts#writeRuntimeFiles
tested-by:
  - coretest:paths.test.ts#resolvePragPathsSuite
  - daemontest:daemon-isolation.test.ts#daemonPRAGROOTIsolationSuite
---
## Objective
Make it possible to run `prag` fully isolated from the developer's own installation with one variable, and make that isolation assertable before anything destructive runs (ADR-019).

This blocks every other test task. Until it exists, any test that reaches `prag reembed` (drops all content tables, ADR-015) or `prag prune --gc-chunks` (deletes and compacts, ADR-017) can destroy the developer's real index because a single unset variable falls back to their real XDG path.

## Requirements
- Implement `PRAG_ROOT` in `@prag/core`'s path resolution: when set, derive `dataDir = <root>/data`, `configDir = <root>/config`, `runDir = <root>/state`, `logDir = <root>/state/logs`.
- Precedence, in order: an explicitly set `PRAG_DATA_DIR`/`PRAG_CONFIG_DIR`/`PRAG_RUN_DIR`/`PRAG_LOG_DIR` wins; otherwise the `PRAG_ROOT`-derived path; otherwise the XDG/platform default. When `PRAG_ROOT` is set, an unset category must **never** fall back to XDG.
- Create the derived directories on demand with the same permissions as the XDG paths (`daemon.token` legacy file stays `0600`, ADR-013).
- Add `root`, `dataDir`, `configDir` and `runDir` to the `GET /health` response so a harness can assert where the daemon is actually rooted. These are paths, not content — `/health` stays unauthenticated and still exposes no indexed data or grants.
- Update `env-and-storage-paths.md` with `PRAG_ROOT` and the precedence rules.

## Verification
- With `PRAG_ROOT=<tmp>` and no other path variables set, no file is created under any XDG path during a full index-and-search cycle. Assert by snapshotting the real paths before and after.
- With `PRAG_ROOT=<tmp>` and `PRAG_DATA_DIR=<other>` both set, data lands in `<other>` and config/state/logs land under `<tmp>`.
- `GET /health` reports `root` equal to `<tmp>`.
- Deleting `<tmp>` removes every trace of the instance.

## Implementation status

Complete. Every requirement has production wiring and a test that observes it.

- **Directories created on demand.** `ensurePragDirs()` (`packages/core/src/paths.ts:140`)
  mkdir -p's all four. `resolvePragPaths()` stays pure on purpose — a test that only
  resolves paths must not touch the filesystem — so the two entry points that are about
  to *use* them call it: `loadConfig()` before reading config.json
  (`packages/daemon/src/main.ts:53`) and `prag daemon rotate-secret`.
  Without this the documented `~/.config/prag/config.json` was silently ignored on a
  fresh machine, because nothing else ever created `configDir` (LanceDB makes only its
  own data directory, `writeRuntimeFiles` only `runDir`).
- **`daemon.token` 0600.** Written at startup by `writeRuntimeFiles()`
  (`packages/daemon/src/main.ts:197-204`), only when the token is the default `guest`;
  `chmodSync` follows the `writeFileSync` mode because mode is ignored for a file that
  already exists. Asserted as `statSync().mode & 0o777 === 0o600`, and that an explicit
  `PRAG_API_KEY` leaves no token file on disk.
- **Verification cycle.** `packages/daemon/test/daemon-isolation.test.ts` drives
  `loadConfig()`/`bootstrap()`/`writeRuntimeFiles()` rather than re-deriving
  `resolvePragPaths()` and asserting the string equals itself: a real register + sync +
  search cycle runs with all three XDG roots pointed at a scratch directory, which is
  then asserted *entirely* empty, and `PRAG_DATA_DIR` precedence is checked by where
  `lancedb/` actually lands. Deleting the root after a cycle removes the instance.


Remaining: `mkdir -p` the derived dirs at path-resolution time with `daemon.token` at
`0600`; extend the isolation test to a real index+search cycle over all three XDG roots.
