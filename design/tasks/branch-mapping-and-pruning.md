---
class: task
id: branch-mapping-and-pruning.md
title: Implement branch_mapping table schema and branch pruning lifecycle
status: in_progress
priority: high
relates-to:
  - feature:git-branch-awareness.md
tested-by:
  - daemontest:daemon.test.ts#daemonSuite
---
## Description
Implement the 4th table in the LanceDB schema: `branch_mapping`.

## Requirements
- Define schema with columns: `branch` (string, PK), `projectId` (string, PK), `uri` (string, PK), `fileVersionId` (string, FK), and `updatedAt` (datetime).
- Implement synchronization logic when a branch is checked out: copy file pointers to the new branch for all matching files.
- Implement deletion of `branch_mapping` rows when a file is deleted on a branch.
- Implement branch pruning command/routine: purge records from `branch_mapping` when a branch is deleted in Git.
- Implement orphan cleanup query to purge `file_mapping` and `chunk_mapping` rows with no active branch reference. This runs by default on `prag prune` / `prune_index` (no flag needed).
- Implement `chunks_pool` GC as a separate, explicitly opt-in step gated behind `--gc-chunks` (CLI) / `gcChunks: true` (MCP `prune_index`): delete rows with no `chunk_mapping` reference, cascade the delete to their `vector_pool` rows, then compact both via `table.optimize()`. Never automatic, never reference-counted (ADR-017).
- Drain and pause the ingestion queue around the `--gc-chunks` sweep, resuming afterwards. Dedup reads `chunks_pool` before writing the `chunk_mapping` pointer, so a concurrent sweep would delete the chunk in that gap and leave a dangling pointer (ADR-017). Plain `prag prune` needs no pause.