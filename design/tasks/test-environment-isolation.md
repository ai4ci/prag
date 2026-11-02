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
  - src:core/src/paths.ts#PragPaths
  - src:core/src/paths.ts#PragConfig
  - src:core/src/paths.ts#loadPragConfig
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
