---
class: task
id: cli-read-only-search.md
title: Implement short-lived CLI client with lazy daemon spawning and HTTP queries
status: todo
priority: high
relates-to:
  - feature://dual-interfaces.md
---
## Description
Implement the short-lived CLI client (@prag/cli) for querying the index and managing the daemon.

## Requirements
- Read daemon port and host from `~/.config/prag/config.json` (fallback to default 7724 on 127.0.0.1).
- Implement lazy daemon startup: if `GET /health` fails, spawn daemon process detached (`@prag/daemon`), poll until ready (timeout 5s), then proceed with query.
- Detect active git branch automatically using local git HEAD if `--branch` is not explicitly provided.
- Detect the current project (cwd git-root walk against registered `projects`) for `search-local`'s default scoping.
- Implement `prag search-local <query>` (scoped, default) and `prag search-all <query>` (unscoped) calling `POST /search` on the daemon and rendering styled terminal results in <15ms (ADR-018).
- Implement daemon lifecycle subcommands: `prag daemon start`, `prag daemon status`, `prag daemon stop` (`POST /shutdown`), `prag daemon token`, and `prag daemon rotate-secret` (ADR-013).
- Validate `/health`'s `service`/`version` fields before trusting a discovered port; fail loudly with no automatic port fallback on mismatch (ADR-016).
- Attach `Authorization: Bearer <token>` (read from `daemon.token`) on every request except `/health` (ADR-013).