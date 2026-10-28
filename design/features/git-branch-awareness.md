---
class: feature
id: git-branch-awareness.md
title: Git Branch Awareness and State Continuity
status: accepted
priority: high
area: storage
guided-by:
  - adr://ADR-002.md
  - adr://ADR-001.md
  - adr://ADR-004.md
  - adr://ADR-017.md
---
## Overview
The indexing workspace must map file metrics against the active Git working branch. When switching branches (`git checkout`), data modifications must be safely partitioned. Unchanged files shared across branches must be tracked efficiently to bypass computational overhead.

## Storage Architecture
Governed by the 4-table Content-Addressable Storage (CAS) and branch-pointer model defined in [Storage Schema](../resources/storage-schema.md):

- `branch_mapping`: Mutable pointer tracking which `fileVersionId` is active for a given `(projectId, branch, uri)` tuple.
- `file_mapping`: Tracks immutable file content revisions keyed by `fileVersionId = ${uri}::${contentHash}`.
- `chunk_mapping`: Connects `fileVersionId` to ordered `chunkIndex` and `chunkHash` entries.
- `chunks_pool`: Deduplicated global pool storing `chunkHash` (SHA-1), dense float vector array, and raw `text` block.

## Git Churn Behavior & Branch Pointer Resolution
- **Branch Switch:** When branching or checking out a new branch, files identical to the base branch share identical `contentHash` values. Writing to `branch_mapping` only links `(newBranch, projectId, uri)` to existing `fileVersionId` records. Zero re-parsing and zero vector computation occur.
- **File Modification:** When a file changes on a branch, a new `fileVersionId` is created in `file_mapping`, chunks are added to `chunk_mapping` and `chunks_pool`, and the single pointer in `branch_mapping` is updated. Other branches continue pointing to their respective historical `fileVersionId`.
- **File Deletion:** When a file is unlinked/deleted on a branch, its row in `branch_mapping` is deleted. Historical versions on other branches remain untouched.

## Branch Pruning and Garbage Collection (GC)
- When a Git branch is deleted (`git branch -d` / `prune`), the daemon or CLI removes stale pointers:
  ```sql
  DELETE FROM branch_mapping WHERE projectId = $projectId AND branch = $deletedBranch;
  ```
- Unreferenced `file_mapping` and `chunk_mapping` records are cleaned by default whenever `prag prune` / MCP `prune_index` runs (always a manual, explicit call -- never scheduled).
- `chunks_pool` is never swept as part of that default pass: it acts as a permanent, content-addressable cache, and is only garbage-collected when `--gc-chunks` / `gcChunks: true` is explicitly passed, via either the CLI or the `prune_index` MCP tool (ADR-017).
