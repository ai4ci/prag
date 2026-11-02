---
class: task
id: cli-read-only-search.md
title: Implement short-lived CLI client with lazy daemon spawning and HTTP queries
status: in_progress
priority: high
relates-to:
  - feature:dual-interfaces.md
blocks:
  - task:workspace-isolation-enforcement.md
addressed-by:
  - src:cli/src/daemon-client.ts#DaemonClient
  - src:cli/src/main.ts#main
tested-by:
  - clitest:daemon-client.test.ts#daemonClientSuite
  - clitest:e2e.test.ts#cLIEndToEndSuite
  - clitest:discovery.test.ts#daemonDiscoverySuite
---
## Description
Implement the short-lived CLI client (@prag/cli) for querying the index and managing the daemon.

## Requirements
- Read daemon port and host from `~/.config/prag/config.json` (fallback to default 7724 on 127.0.0.1).
- Implement lazy daemon startup: if `GET /health` fails, spawn daemon process detached (`@prag/daemon`), poll until ready (timeout 5s), then proceed with query.
- Detect active git branch automatically using local git HEAD if `--branch` is not explicitly provided.
- Detect the current project (cwd git-root walk against registered `projects`) for `search-local`'s default scoping; `--project` overrides it.
- Implement `prag search-local <query>` (always sends a `projectId`, `--project` available) and `prag search-all <query>` (never sends a `projectId`, exposes **no** project option) calling `POST /search` on the daemon and rendering styled terminal results well inside the 100ms interactive budget (ADR-018).
- Implement daemon lifecycle subcommands: `prag daemon start`, `prag daemon status`, `prag daemon stop` (`POST /shutdown`), `prag daemon token`, and `prag daemon rotate-secret` (ADR-013).
- Validate `/health`'s `service` and `apiVersion` fields before trusting a discovered port; fail loudly with no automatic port fallback on mismatch (ADR-016). Never compare the daemon's package `version` -- report it in errors only.
- Exempt `prag daemon stop|status|token|rotate-secret` from the `apiVersion` check (they still require a matching `service`), so the documented recovery path out of a version mismatch is not blocked by that same mismatch (ADR-016).
- Attach `Authorization: Bearer <token>` (read from `PRAG_API_KEY` or `daemon.token`) on every request except `/health` (ADR-013).

## Implementation status

Reverted from `done`: the lazy-spawn path, lifecycle subcommands, and the
`service`/`apiVersion` handshake are real and tested, but branch detection is absent
entirely and the scoping path can silently widen to every project.

- **Branch detection — MISSING.** Nothing reads git HEAD: `detectBranch`, `gitBranch`,
  `symbolic-ref`, `rev-parse` and `.git/HEAD` have no match anywhere in
  `packages/cli/src` or `packages/core/src`. `--branch` appears once, in the usage
  string (`packages/cli/src/main.ts:31`), and `parseArgs` output is never consulted
  for it; the request built at `main.ts:189-194` carries `query`, `projectId`,
  `limit`, `mode` and no branch. `SearchQueryOptions.branch`
  (`packages/core/src/schema.ts:77-82`) is dead — grep finds only its definition and
  the re-export. Consequence: `SearchHit.branch` (`packages/cli/src/daemon-client.ts:24`)
  is never populated, because `SearchFileHit` (`packages/core/src/search.ts:19-27`)
  has no branch field to carry it.
- **Config read — DONE (2026-11-02).** `readPort()` in `packages/cli/src/daemon-client.ts`
  applies the daemon's own precedence (`PRAG_PORT` → `server.port` in config.json → 7724)
  via `loadPragConfig(resolvePragPaths().configDir)`, resolving paths read-only so
  `prag status` creates nothing. A malformed config.json falls back to the default port
  rather than throwing before the CLI has reported anything -- the daemon keeps the hard
  error. Asserted by `packages/cli/test/discovery.test.ts` (5 cases).
- **Project inference — PARTIAL.** `inferProjectId`
  (`packages/cli/src/daemon-client.ts:504-519`) is a longest-prefix
  `cwd.startsWith(rootUri)` test — no git-root walk, no `.git` check, no `$default`
  sentinel. It resolves a registered project correctly for the documented usage
  (`prag watch <dir>` then search from inside it); the git-root walk would only matter
  for a sibling checkout of the same repository.
- **Scoping leak — CLOSED (2026-11-02).** When inference fails, `search-local` now raises
  `PROJECT_ID_REQUIRED` with a remedy naming `--project`, `search-all` and `prag watch`
  (`packages/cli/src/main.ts:216-227`) instead of sending `projectId: undefined`, which
  was an unscoped whole-index search from an unrelated directory -- the exact case ADR-018
  forbids. Asserted by the new subprocess test "search-local outside every project is an
  error, not a whole-index search", which checks both the rejection *and* that cwd
  inference still works from inside the project.
- **Rendering reads absent fields.** `main.ts:208-209` prints `hit.projectId` and
  `hit.filePath`; the daemon returns `uri`/`fileVersionId`, so those print
  `undefined`. `--mode` is sent (`main.ts:193`) and never read by the daemon
  (`daemon.ts:349-364`).

Remaining: make project inference a git-root walk (nice-to-have, see above); the
hit-rendering fields and `--mode` threading are fixed, branch detection is done
(`packages/core/src/branch.ts` + `main.ts:246-258`), so this task is otherwise closed.