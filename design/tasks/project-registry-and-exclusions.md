---
class: task
id: project-registry-and-exclusions.md
title: Implement grants and projects tables with allow/deny evaluation and Chokidar filter integration
status: done
priority: high
relates-to:
  - feature:project-registry-and-status.md
addressed-by:
  - src:core/src/schema.ts#evaluateUriGrants
  - src:core/src/schema.ts#GrantRow
  - src:core/src/schema.ts#ProjectRow
  - src:core/src/schema.ts#uriMatch
  - src:core/src/schema.ts#GrantEvaluation
  - src:daemon/src/ingestion-queue.ts#IngestionQueue.registerProject
tested-by:
  - coretest:schema.test.ts#evaluateUriGrantsSuite
  - clitest:e2e.test.ts#cLIEndToEndSuite
  - daemontest:child-repos.test.ts
  - coretest:discovery-repos.test.ts
---
## Description
Implement the `grants` and `projects` tables in LanceDB, along with allow/deny evaluation and Chokidar watcher filter integration.

## Requirements
- Define LanceDB schemas for `grants` and `projects` in `@prag/core`.
- Implement allow/deny evaluation engine: longest-prefix match, deny by default, deny breaks ties, and built-in vendor ignores.
- Implement URI normalization helper (`file:///...` and `https://...`).
- Integrate grant evaluation into Chokidar file watcher: evaluate directory paths before descending, halting descent immediately on `deny`.
- Implement project discovery: scan allowed URI space, detecting atomic Git repositories and registering them into `projects`.
- Implement CLI commands `prag watch <uri>`, `prag deny <uri>`, `prag grants`, and `prag status`.
- Expose MCP tools `get_indexing_status`, `watch_uri`, and `deny_uri`.

## Implementation status

Re-audited and completed 2026-11-02.

- **Grant engine, URI normalization, `grants`/`projects` schemas — DONE.**
- **Grants gate ingestion — DONE.** `_checkFile` consults the grants table on
  the ingestion path, so a `deny` now decides what is indexed rather than only
  answering the `/grants/evaluate` dry run.
- **Project discovery — DONE.** `discoveryDryRun` returns `repos`: the path of
  every git repository found, root first. `watchUri` registers each as its own
  `projects` row with its own watcher, and gives the parent an exclusion list so
  it does not also claim its children's files (ADR-009 §3). A linked worktree is
  detected too: its `.git` is a file, and the previous `isDirectory()` test
  silently folded every worktree into its parent.
- **CLI commands and MCP tools — DONE.**

Found while implementing this, and fixed here: the per-project reconcile walk
called `_shouldIgnore(full)` without the project id, so it re-added every
excluded file on the parent's behalf and bypassed the watcher's exclusion
entirely. See `issue:ingestion-dirty-set-keyed-by-uri-alone.md` for the related
ownership race this exposed but does not fix.
