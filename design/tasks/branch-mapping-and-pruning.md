---
class: task
id: branch-mapping-and-pruning.md
title: Implement branch_mapping table schema and branch pruning lifecycle
status: todo
priority: high
relates-to:
  - feature://git-branch-awareness.md
---
## Description
Implement the 4th table in the LanceDB schema: `branch_mapping`.

## Requirements
- Define schema with columns: `branch` (string, PK), `projectId` (string, PK), `uri` (string, PK), `fileVersionId` (string, FK), and `updatedAt` (datetime).
- Implement synchronization logic when a branch is checked out: copy file pointers to the new branch for all matching files.
- Implement deletion of `branch_mapping` rows when a file is deleted on a branch.
- Implement branch pruning command/routine: purge records from `branch_mapping` when a branch is deleted in Git.
- Implement optional orphan cleanup query to purge `file_mapping` and `chunk_mapping` rows with no active branch reference.