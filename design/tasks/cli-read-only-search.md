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
- **Config read — PARTIAL.** `DaemonClient` resolves the port from
  `process.env.PRAG_PORT ?? DEFAULT_PORT` (`packages/cli/src/daemon-client.ts:163`);
  `loadPragConfig` is never imported in `packages/cli/src`. A `server.port` in
  config.json is honoured by the daemon and ignored by the client, so a non-default
  port only works if exported into the environment.
- **Project inference — PARTIAL.** `inferProjectId`
  (`packages/cli/src/daemon-client.ts:399-414`) is a longest-prefix
  `cwd.startsWith(rootUri)` test — no git-root walk, no `.git` check, no `$default`
  sentinel.
- **Scoping leak.** When inference fails, `search-local` sends
  `projectId: undefined` (`main.ts:186` → serialised at `daemon-client.ts:303-310`),
  which is exactly the ADR-018 case that must be `PROJECT_ID_REQUIRED`. It becomes a
  silent whole-index search today because `hybridSearch` takes no project filter —
  fixed by `task:search-project-scoping.md`, and this task's requirement line is only
  met once that lands.
- **Rendering reads absent fields.** `main.ts:208-209` prints `hit.projectId` and
  `hit.filePath`; the daemon returns `uri`/`fileVersionId`, so those print
  `undefined`. `--mode` is sent (`main.ts:193`) and never read by the daemon
  (`daemon.ts:349-364`).

Remaining: implement git HEAD detection (with `--branch` override) and thread branch
through the request; read config.json in the client; make project inference a git-root
walk; return an error rather than an unscoped query when the project cannot be
resolved; fix the hit rendering fields.