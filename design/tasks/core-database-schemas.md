---
class: task
id: core-database-schemas.md
title: Define LanceDB database schemas and interfaces in @prag/core
status: todo
priority: high
relates-to:
  - feature://git-branch-awareness.md
blocks:
  - task://lancedb-init-scripts.md
---
## Objective
Define the shared TypeScript database schemas, table models, and interfaces in `@prag/core` matching the 7-table storage specification.

## Implementation Details
- Tables: `grants`, `projects`, `branch_mapping`, `file_mapping`, `chunk_mapping`, `chunks_pool`, and `vector_pool`.
- Keep the chunk / vectorised-unit split explicit in the types (ADR-014): `chunks_pool` carries `chunkHash` + `text` and no vector; `vector_pool` is keyed `(chunkHash, unitIndex)` and carries the vector.
- Export TypeScript interfaces for records, query filters, and grant evaluation.
- Define column types and schemas compatible with LanceDB / Apache Arrow.