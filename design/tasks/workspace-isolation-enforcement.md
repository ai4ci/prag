---
class: task
id: workspace-isolation-enforcement.md
title: Enforce project-scoped query and storage isolation across workspaces
status: in_progress
priority: medium
relates-to:
  - feature:workspace-isolation.md
tested-by:
  - coretest:search-scoping.test.ts
---
## Objective
Verify and enforce multi-project isolation guarantees described in `workspace-isolation.md` beyond the basic `projectId` column.

## Requirements
- Ensure `search-local`/`search_local` never returns hits outside the resolved `projectId`; only `search-all`/`search_all` is unscoped (ADR-018 resolves the previously-open default-scope question).
- Add a test asserting that a search scoped to `projectId: A` never returns chunks from `projectId: B`, even when both share identical normalized chunk text (dedup must not leak project boundaries at the API layer, even though `chunks_pool` content is globally deduplicated).
- Verify `filePatterns` glob filters in `ProjectWorkspaceConfig` are applied consistently by both the Chokidar watcher and the grants evaluation engine.

## Implementation status

Re-audited 2026-11-02: raised from `todo` to `in_progress`. It was never `todo` — two
of its three requirements were delivered by `task:search-project-scoping.md`.

- **`search-local` never leaves its project — DONE.** Enforced on the search
  path and at the CLI boundary (ADR-018).
- **Cross-project leak test — DONE.** `core/test/search-scoping.test.ts`
  asserts that a search scoped to project A returns nothing from project B even
  when both share byte-identical chunk text, so global `chunks_pool` dedup does
  not leak across the API boundary.

Outstanding:

- **`filePatterns` glob consistency — UNVERIFIED.** Nothing asserts that the
  Chokidar watcher and the grants evaluation engine apply
  `ProjectWorkspaceConfig.filePatterns` identically. A divergence here is
  invisible until a file is silently watched but not grantable, or vice versa.
