---
class: feature
id: workspace-isolation.md
title: Multi-Project Multi-Tenant Isolation
status: accepted
priority: medium
area: ingestion
---
## Overview
The engine must independently manage distinct target folder workspaces (e.g. software repositories or personal knowledge bases), assigning static scopes to prevent cross-contamination unless explicitly requested during runtime querying.

## Requirements & Interfaces
Workspaces are configured and registered via `ProjectWorkspaceConfig`:

```typescript
export interface ProjectWorkspaceConfig {
  id: string;              // Unique project slug identifier
  rootUri: string;         // Absolute path to root workspace folder
  isGit: boolean;          // Whether the folder is backed by a Git repository
  filePatterns?: string[]; // Optional glob filters to track or ignore
}
```

- Storage isolation: every indexed file entry in `file_mapping` carries `projectId`.
- Query filtering: queries can specify `scopeProjectId` to restrict scalar predicates in LanceDB.