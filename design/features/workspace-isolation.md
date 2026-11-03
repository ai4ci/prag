---
class: feature
id: workspace-isolation.md
title: Multi-Project Multi-Tenant Isolation
status: in_progress
priority: medium
area: ingestion
implemented-by:
  - src:core/src/paths.ts#resolvePragPaths
---
## Overview
The engine must independently manage distinct target folder workspaces (e.g. software repositories or personal knowledge bases), assigning static scopes to prevent cross-contamination unless explicitly requested during runtime querying.

## Requirements & Interfaces
Workspaces are configured and registered via `ProjectWorkspaceConfig`:

```typescript
export interface ProjectWorkspaceConfig {
  id: string;     // projectId: the absolute normalized root URI of the project
  rootUri: string; // Absolute path to root workspace folder
  isGit: boolean;  // Whether the folder is backed by a Git repository
}
```

**`filePatterns` was removed 2026-11-03.** It predated ADR-009, which made
allow/deny URI grants the single mechanism for deciding what is indexed --
longest-prefix match, deny-by-default, plus the built-in ignores. A
per-project glob list is a second mechanism for the same job, and two policy
surfaces that can disagree is exactly the divergence
`task:workspace-isolation-enforcement.md` was written to guard against: a
`filePatterns: ["src/**"]` alongside a `deny file:///repo/src/secrets.ts`
needs a precedence rule nobody wrote, and the watcher and the grant evaluator
would each have to reach the same answer.

Nothing was lost by removing it. It was never implemented -- neither the
field nor `ProjectWorkspaceConfig` itself appears in `packages/` -- and the
protection it was imagined to give comes from the built-in ignore list
(`node_modules`, `.git`, `dist`, `build`, `target`, hidden directories) and
from grants, both of which it would have duplicated. The runtime growth bound
(`ingestion.growth`) covers the case it could not have: a large directory
arriving *after* registration.

- Storage isolation: every indexed file entry in `file_mapping` carries `projectId`.
- Query filtering: queries can specify `scopeProjectId` to restrict scalar predicates in LanceDB.