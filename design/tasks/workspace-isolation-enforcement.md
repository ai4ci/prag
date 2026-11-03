---
class: task
id: workspace-isolation-enforcement.md
title: Enforce project-scoped query and storage isolation across workspaces
status: blocked
priority: medium
relates-to:
  - feature:workspace-isolation.md
tested-by:
  - coretest:search-scoping.test.ts
---
## Objective
Verify and enforce multi-project isolation guarantees described in `workspace-isolation.md` beyond the basic `projectId` column.

## Requirements
- Ensure `search-local`/`search_local` never returns hits outside the resolved `projectId`; only `search-all`/`search_all` is unscoped (ADR-018 resolves the previously-open default-scope question).
- Add a test asserting that a search scoped to `projectId: A` never returns chunks from `projectId: B`, even when both share identical normalized chunk text (dedup must not leak project boundaries at the API layer, even though `chunks_pool` content is globally deduplicated).
- Verify `filePatterns` glob filters in `ProjectWorkspaceConfig` are applied consistently by both the Chokidar watcher and the grants evaluation engine.

## Implementation status

Re-audited 2026-11-02: raised from `todo` to `in_progress`. It was never `todo` — two
of its three requirements were delivered by `task:search-project-scoping.md`.

- **`search-local` never leaves its project — DONE.** Enforced on the search
  path and at the CLI boundary (ADR-018).
- **Cross-project leak test — DONE.** `core/test/search-scoping.test.ts`
  asserts that a search scoped to project A returns nothing from project B even
  when both share byte-identical chunk text, so global `chunks_pool` dedup does
  not leak across the API boundary.

Outstanding:

- **`filePatterns` glob consistency — UNVERIFIED.** Nothing asserts that the
  Chokidar watcher and the grants evaluation engine apply
  `ProjectWorkspaceConfig.filePatterns` identically. A divergence here is
  invisible until a file is silently watched but not grantable, or vice versa.

## Parked 2026-11-03: `filePatterns` needs a decision, not an implementation

Requirement 3 asks to "verify `filePatterns` glob filters in
`ProjectWorkspaceConfig` are applied consistently by both the Chokidar watcher
and the grants evaluation engine". Neither identifier exists anywhere in
`packages/` -- `grep -rn "filePatterns|ProjectWorkspaceConfig" packages/`
returns nothing. They appear only in `feature:workspace-isolation.md`.

So there is nothing to verify. The question is whether `filePatterns` should
exist at all:

- **ADR-009 made allow/deny URI grants the single mechanism** for deciding what
  is indexed, with longest-prefix match, deny-by-default and built-in vendor
  ignores. A per-project glob list is a second mechanism for the same job, and
  two policy surfaces that can disagree is precisely the divergence this
  requirement was written to guard against.
- The feature document predates ADR-009, which is the likely explanation.

**Question for the maintainer.** Either:

1. Drop `filePatterns` from `feature:workspace-isolation.md` and close this
   requirement, with grants as the only filter -- the cheaper and, on ADR-009's
   logic, the more coherent option; or
2. Keep it as per-project ergonomics (a `.pragignore`-style convenience that
   compiles down to grant rows at registration, so there is still one
   evaluation engine and no second source of truth).

Option 2 is the only way to keep it without reintroducing the divergence.
Nothing else in this task is blocked on the answer: the first two requirements
are implemented and tested.
