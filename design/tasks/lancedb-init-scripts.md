---
class: task
id: lancedb-init-scripts.md
title: Implement LanceDB initialization scripts with 6-table schema setup
status: todo
priority: high
relates-to:
  - feature://git-branch-awareness.md
blocks:
  - task://daemon-ingestion-queue.md
  - task://cli-read-only-search.md
---
## Objective
Implement initialization scripts and table bootstrap utilities for LanceDB in `@prag/core`.

## Implementation Details
- Connect to local LanceDB instance using Apache Arrow settings.
- Implement table creation and schema verification for the 6-table schema (`grants`, `projects`, `branch_mapping`, `file_mapping`, `chunk_mapping`, `chunks_pool`).
- Create BM25 full-text search (FTS) index on `chunks_pool.text`.
- Provide helper methods for transactional batch upserts of chunks and mapping pointers.