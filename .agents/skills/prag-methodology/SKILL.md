---
name: prag-methodology
description: Procedures, validation rules, and lifecycle transitions for managing features, architecture decision records, tasks, and issues in prag using loom.
---

# prag Development Methodology

This repository uses `loom` governed by `design/document-model.mmd`.
Refer to `using-loom-cli` for general CLI operation syntax.

## 1. Document Classes & Locations

Class locations are declared in `design/document-model.mmd` with semantic-web
`%% @prefix <class>: <target> .` lines (loom >= 0.10; the old `%% @path` form is
rejected with `model/path-removed`). URIs are **curies** — `feature:x.md`, not
`feature://x.md`. The resolved prefixes are exported to
`design/.loom/namespaces.ttl` by `loom rebuild`.

- **`feature`**: `feature:<slug>.md` -> `design/features/<slug>.md`
  - Defines product and architectural capabilities, system requirements, and interface boundaries.
  - Attributes: `title`, `status` (`draft` | `accepted` | `in_progress` | `completed`), `priority` (`low` | `medium` | `high`), `area` (`core` | `daemon` | `storage` | `ingestion` | `interface`).
  - Lifecycle: `draft` = requirements still being specified; `accepted` = scope approved, implementation not started; `in_progress` = implementation started but scope incomplete; `completed` = scoped requirements implemented and tested. Keep a feature `in_progress` while any explicit requirement remains unmet; related task completion alone does not complete the feature.
- **`task`**: `task:<slug>.md` -> `design/tasks/<slug>.md`
  - Actionable engineering work items to be implemented by contributors/agents.
  - Attributes: `title`, `status` (`todo` | `in_progress` | `done` | `blocked`), `priority` (`low` | `medium` | `high`).
- **`issue`**: `issue:<slug>.md` -> `design/issues/<slug>.md`
  - Defects, bugs, test regressions, or unexpected behaviors discovered during development or runtime.
  - Attributes: `title`, `status` (`open` | `in_progress` | `resolved` | `closed`), `priority` (`low` | `medium` | `high`).
- **`adr`**: `adr:<slug>.md` -> `design/adrs/<slug>.md`
  - Architecture Decision Records documenting context, decisions, consequences, and evaluated alternatives.
  - Attributes: `title`, `status` (`proposed` | `accepted` | `superseded`), `decided` (`YYYY-MM-DD`).
- **Source code anchors**: `src:<relpath>#<symbol>` -> `packages/<relpath>`
  - The `packages/` prefix is *dropped* in the curie: `src:core/src/schema.ts#initDatabase` is `packages/core/src/schema.ts`.
- **Resources**: `resource:<relpath>` -> `design/resources/<relpath>` (e.g. schemas, diagrams)
- **Tests**: `test` is an abstract `src` subclass with one concrete scheme per package:
  - `coretest:<file>#<suite>` -> `packages/core/test/<file>`
  - `daemontest:<file>#<suite>` -> `packages/daemon/test/<file>`
  - `clitest:<file>#<suite>` -> `packages/cli/test/<file>`
  - Tests live in `packages/<pkg>/test/`, **not** colocated with source: loom
    class schemes are directories, so a colocated test cannot be distinguished
    from its `src` sibling (`path/collision`).
  - Each `void describe(...)` block is a **named** suite function so it is an
    anchorable symbol (`function daemonSuite(): void { ... }` followed by
    `void describe("Daemon", daemonSuite);`). Anonymous arrow callbacks carry no
    anchor and cannot be linked.

### Every implemented task must be tested

`task "0..*" --> "0..*" test : tested-by` — link the suite in the same commit that
implements the task:

```bash
loom link task:hybrid-search-rrf.md tested-by "coretest:search.test.ts#searchSuite"
```

This is `0..*`, not `1..*`, on purpose. Cardinality in the model cannot be
conditioned on lifecycle status, so `1..*` turned every unimplemented
`status: todo` task into a hard `instance/cardinality` error — which made
`loom validate` fail on an otherwise clean tree and unusable as a gate. The
enforceable form is a view instead:

```bash
loom index && grep -A5 "untested_task_list" design/INDEX.md   # tasks under way or done, no suite
```

A non-empty result is a real gap: a task that has code but names no suite. An
empty result plus eight `status: todo` tasks is the expected state.

The edge direction is **task -> test** on purpose. The reverse (`test -> task`)
would have to be stored as a reverse-link comment in the test file, and loom
canonicalises that comment's host back to `src:packages/...` (doubled prefix,
wrong scheme), which then fails with `source/invalid-reverse-relation`.

## 2. Common Operations

N.B. loom accepts URIs not file paths.

### Creating a Feature
```bash
loom create feature:my-feature.md "title=My Feature" "status=draft" "priority=medium" "area=daemon"
loom body set feature:my-feature.md "Detailed description of the feature..."
```

### Creating an Engineering Task
```bash
loom create task:my-task.md "title=Implement feature X" "status=todo" "priority=high"
loom link task:my-task.md relates-to feature:my-feature.md
```

### Reporting an Issue (Bug / Regression)
```bash
loom create issue:bug-in-indexer.md "title=Memory leak in tree-sitter loop" "status=open" "priority=high"
loom link issue:bug-in-indexer.md relates-to feature:syntax-aware-chunking.md
loom link issue:bug-in-indexer.md blocks task:release-daemon.md
```

### Linking Dependencies (Blocks)
```bash
loom link task:core-database-schemas.md blocks task:lancedb-init-scripts.md
```

### Linking Code to Features/Tasks
```bash
loom link feature:git-branch-awareness.md implemented-by src:core/src/database/schema.ts#chunksPool
loom link task:core-database-schemas.md addressed-by src:core/src/database/schema.ts#chunksPool
```

## 2b. Status Honesty

`status: done` on a task is a **claim about code**, not about intent, and the graph
is what implementers trust. Before setting `done`, walk every requirement line and
name the file:line that satisfies it; if a line cannot be cited, the task is
`in_progress`, not `done`. The same test applies to a feature's `completed`.

Two failure modes found in this repo, both worth guarding against:

- **Endpoint exists != requirement met.** Registering `POST /sync`, or an MCP tool
  that accepts a `projectId`, satisfies the prose an implementer skims while leaving
  the actual guarantee (a drain barrier, a query filter) unimplemented. Read the
  handler, not the route table.
- **Tests that sleep are not evidence.** A suite that passes because of
  `await sleep(1500)` before an assertion proves timing, not behaviour. When a task's
  Verification section says "no sleeps", a sleep anywhere in the covering test means
  the requirement is unmet.

When reverting an over-claimed task, say why in the commit message and record the
missing behaviour as an `issue` if it is a defect (data loss, silent wrong answer)
rather than leaving it as an unmet line inside a task.

## 3. Lifecycle Transition Rules

### Moving a Task to `in_progress`
Check for blocking tasks or issues first:
```bash
loom query "SELECT subject FROM edge WHERE object = 'task:my-task.md' AND relation = 'blocks'"
```
If no blockers remain:
```bash
loom set task:my-task.md status=in_progress
```

### Completing a Task
Verify that code anchors or tests are linked:
```bash
loom refs src:core/src/database/schema.ts
loom set task:my-task.md status=done
```

## 4. Pre-Commit Checklist
Always run before committing changes to design docs:
```bash
loom validate --fix   # repairs stale link blocks, non-canonical URIs, renamed symbols
loom rebuild          # refresh the DuckDB projection + namespaces.ttl
loom render           # refresh the <!-- loom view: ... --> blocks in the INDEX files
loom index --check    # no legacy loom:links blocks should be stale
```
Require `loom validate` to print `ok: true` (exit 0). Its report is
`design/.loom/VALIDATION.md` -- gitignored, like the per-branch DuckDB beside it.
(The tracked `design/VALIDATION.md` this line used to point at was written by loom
<= 0.8 and is stale: newer loom writes only under `.loom/`, so the old file kept
reporting errors that had already been fixed. It is deleted; do not resurrect it.)

Note for editing `document-model.mmd`: a `%%` comment between a `%% @view name`
line and its SQL becomes part of the query, which then fails at render time with
`Query failed: Parser Error: syntax error at or near "The"`. Put commentary above
the `@view` line.

## 5. Navigational Indexes

`design/INDEX.md` is the single navigation page. The queries live in
`design/document-model.mmd` as `%% @view <name>` annotations — `completed_feature_list`,
`in_progress_feature_list`, `accepted_feature_list`, `draft_feature_list`, `adr_list`,
`issue_list` (open + in_progress only), `resolved_issue_list`, `task_list` (everything not
`done`); each section carries a marker pair like:

```markdown
<!-- loom view: feature_list -->
<!-- loom view: end -->
```

Each view is `SELECT uri FROM <class> WHERE ... ORDER BY ...` — a single `uri` column
renders as a bullet list of titled markdown links.

**`loom render` reads the DuckDB projection, not the files.** If you edited frontmatter
(status, priority) by hand — which `loom set` refuses to do while any cardinality error is
outstanding — the projection is stale and render re-emits the OLD rows while reporting
`updated: []`. Run `loom rebuild` (or `loom validate --fix`) first, then `loom render`, then
confirm with `loom query "SELECT uri, status FROM issue"`. This silently showed resolved
issues under "Open Issues" once.
