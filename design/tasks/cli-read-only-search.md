---
class: task
id: cli-read-only-search.md
title: Implement short-lived CLI client with lazy daemon spawning and HTTP queries
status: done
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

Re-audited 2026-11-02 against the tree and returned to `done`. Every item the previous
audit recorded as missing is now implemented; that audit described a codebase
several commits old and was itself the reason this task read as open.

- **Branch detection — DONE.** The CLI resolves the branch from the project
  root's `.git/HEAD` (`cli/src/main.ts:232`, `core/src/branch.ts`), `--branch`
  is parsed and wins when given (`main.ts:236`), and the resolved value is sent
  on the wire and honoured by the daemon (`daemon/src/daemon.ts:839`).
- **Scoping — DONE.** `search-local` outside any registered project raises
  `PROJECT_ID_REQUIRED` rather than widening (ADR-018), asserted end to end in
  CI as exit code 2.
- **Rendering — DONE.** The client re-uses `SearchFileHit` from `@prag/core`
  instead of keeping a second shape that drifts, so the renderer no longer
  reads fields that do not exist.
