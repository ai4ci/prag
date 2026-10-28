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
Define the shared TypeScript database schemas, table models, and interfaces in `@prag/core` matching the 6-table storage specification.

## Implementation Details
- Tables: `grants`, `projects`, `branch_mapping`, `file_mapping`, `chunk_mapping`, and `chunks_pool`.
- Export TypeScript interfaces for records, query filters, and grant evaluation.
- Define column types and schemas compatible with LanceDB / Apache Arrow.