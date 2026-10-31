---
class: task
id: workspace-isolation-enforcement.md
title: Enforce project-scoped query and storage isolation across workspaces
status: todo
priority: medium
relates-to:
  - feature:workspace-isolation.md
---
## Objective
Verify and enforce multi-project isolation guarantees described in `workspace-isolation.md` beyond the basic `projectId` column.

## Requirements
- Ensure `search-local`/`search_local` never returns hits outside the resolved `projectId`; only `search-all`/`search_all` is unscoped (ADR-018 resolves the previously-open default-scope question).
- Add a test asserting that a search scoped to `projectId: A` never returns chunks from `projectId: B`, even when both share identical normalized chunk text (dedup must not leak project boundaries at the API layer, even though `chunks_pool` content is globally deduplicated).
- Verify `filePatterns` glob filters in `ProjectWorkspaceConfig` are applied consistently by both the Chokidar watcher and the grants evaluation engine.