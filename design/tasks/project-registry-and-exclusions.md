---
class: task
id: project-registry-and-exclusions.md
title: Implement grants and projects tables with allow/deny evaluation and Chokidar filter integration
status: in_progress
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

Reverted from `done`: the grant **engine** is complete and tested in isolation, but it is
not wired into ingestion, so today it decides nothing about what gets indexed.

- **Watcher does not consult grants — MISSING (the load-bearing gap).** Chokidar admission
  uses a hardcoded basename test, `_shouldIgnore` (`packages/daemon/src/ingestion-queue.ts:127-134`:
  dotted names, `node_modules`, `package-lock.json`). `evaluateUriGrants` is called from
  exactly one place — the `/grants/evaluate` dry-run endpoint
  (`packages/daemon/src/daemon.ts:550`) — and never on the ingestion path. "Evaluate
  directories before descending, halt on `deny`" is therefore unimplemented: a `deny` grant
  does not stop a watcher from descending into or indexing the subtree. The built-in vendor
  ignores the requirement assigns to the engine live in `_shouldIgnore` instead.
- **Project discovery — MISSING.** No scan of the allowed URI space and no git-repository
  detection: `grep -rn "\.git|rev-parse|discover" packages/daemon/src/daemon.ts
  packages/daemon/src/ingestion-queue.ts` matches only `_shouldIgnore`'s dotted-name check.
  `POST /projects` requires an existing directory and registers one row
  (`daemon.ts:431-459`); `registerProject` just adds a chokidar watcher (`daemon.ts:153-157`).
  Nothing ever populates `projects` from a grant, so the atomic-repository semantics and the
  `$default` sentinel are unimplemented.
- **`prag watch` / `prag deny` are grant writes only.** `packages/cli/src/main.ts:217-224`
  and `:226-232` call `addGrant` and print a line. `watch` neither starts a scan nor registers
  a watcher; `deny` neither halts watchers nor purges already-indexed content, so previously
  indexed data under a denied prefix stays searchable — ADR-009's revocation guarantee does
  not hold.
- **MCP tools absent.** `get_indexing_status`, `watch_uri`, `deny_uri` have no match in
  `packages/daemon/src/mcp-server.ts` (only `search_local`, `list_grants`, `list_projects` at
  `:72,116,147`). Tracked with the rest of the surface in `task:mcp-server-endpoint.md`.
- **`prag status` reports daemon health only** (`main.ts:277-291`): pid, root, dataDir. No
  project state, chunk counts, or skip counts.

Satisfied: `grants`/`projects` LanceDB schemas; the evaluation engine — longest-prefix,
deny-by-default, deny-breaks-ties, built-in vendor ignores (`packages/core/src/schema.ts#evaluateUriGrants`,
tested `packages/core/test/schema.test.ts#evaluateUriGrantsSuite`); URI normalization
(`#uriMatch`, same suite); the four CLI commands exist as grant/health surfaces.

Remaining: drive watcher admission from the grants engine (directory-level, halt on deny);
implement discovery + git-repository detection into `projects`; make `deny` unwatch and purge
indexed content under the prefix; make `watch` trigger a scan; add the three MCP tools; extend
`prag status` with per-project state.