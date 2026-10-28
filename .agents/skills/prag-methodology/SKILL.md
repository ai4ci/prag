---
name: prag-methodology
description: Procedures, validation rules, and lifecycle transitions for managing features, architecture decision records, tasks, and issues in prag using loom.
---

# prag Development Methodology

This repository uses `loom` governed by `design/document-model.mmd`.
Refer to `using-loom-cli` for general CLI operation syntax.

## 1. Document Classes & Locations

- **`feature`**: `feature://<slug>.md` -> `design/features/<slug>.md`
  - Defines product and architectural capabilities, system requirements, and interface boundaries.
  - Attributes: `title`, `status` (`draft` | `accepted` | `in_progress` | `completed`), `priority` (`low` | `medium` | `high`), `area` (`core` | `daemon` | `storage` | `ingestion` | `interface`).
- **`task`**: `task://<slug>.md` -> `design/tasks/<slug>.md`
  - Actionable engineering work items to be implemented by contributors/agents.
  - Attributes: `title`, `status` (`todo` | `in_progress` | `done` | `blocked`), `priority` (`low` | `medium` | `high`).
- **`issue`**: `issue://<slug>.md` -> `design/issues/<slug>.md`
  - Defects, bugs, test regressions, or unexpected behaviors discovered during development or runtime.
  - Attributes: `title`, `status` (`open` | `in_progress` | `resolved` | `closed`), `priority` (`low` | `medium` | `high`).
- **`adr`**: `adr://<slug>.md` -> `design/adrs/<slug>.md`
  - Architecture Decision Records documenting context, decisions, consequences, and evaluated alternatives.
  - Attributes: `title`, `status` (`proposed` | `accepted` | `superseded`), `decided` (`YYYY-MM-DD`).
- **Source code anchors**: `src://<relpath>#<symbol>` -> mapped to `/packages`
- **Resources**: `resource://<relpath>` -> mapped to `design/resources` (e.g. schemas, diagrams)

## 2. Common Operations

N.B. loom accepts URIs not file paths.

### Creating a Feature
```bash
loom create feature://my-feature.md "title=My Feature" "status=draft" "priority=medium" "area=daemon"
loom body set feature://my-feature.md "Detailed description of the feature..."
```

### Creating an Engineering Task
```bash
loom create task://my-task.md "title=Implement feature X" "status=todo" "priority=high"
loom link task://my-task.md relates-to feature://my-feature.md
```

### Reporting an Issue (Bug / Regression)
```bash
loom create issue://bug-in-indexer.md "title=Memory leak in tree-sitter loop" "status=open" "priority=high"
loom link issue://bug-in-indexer.md relates-to feature://syntax-aware-chunking.md
loom link issue://bug-in-indexer.md blocks task://release-daemon.md
```

### Linking Dependencies (Blocks)
```bash
loom link task://core-database-schemas.md blocks task://lancedb-init-scripts.md
```

### Linking Code to Features/Tasks
```bash
loom link feature://git-branch-awareness.md implemented-by src://core/src/database/schema.ts#chunksPool
loom link task://core-database-schemas.md addressed-by src://core/src/database/schema.ts#chunksPool
```

## 3. Lifecycle Transition Rules

### Moving a Task to `in_progress`
Check for blocking tasks or issues first:
```bash
loom query "SELECT subject FROM edge WHERE object = 'task://my-task.md' AND relation = 'blocks'"
```
If no blockers remain:
```bash
loom set task://my-task.md status=in_progress
```

### Completing a Task
Verify that code anchors or tests are linked:
```bash
loom refs src://packages/core/src/database/schema.ts
loom set task://my-task.md status=done
```

## 4. Pre-Commit Checklist
Always run before committing changes to design docs:
```bash
loom validate --fix
loom index
```
Ensure zero errors reported in `design/VALIDATION.md`.
