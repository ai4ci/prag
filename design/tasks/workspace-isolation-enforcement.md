---
class: task
id: workspace-isolation-enforcement.md
title: Enforce project-scoped query and storage isolation across workspaces
status: blocked
priority: medium
relates-to:
  - feature:workspace-isolation.md
tested-by:
  - coretest:ignore-scope.test.ts#ignoreScopeSuite
  - daemontest:watcher-pruning.test.ts#watcherPruningSuite
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

## 2026-11-03: what actually bounds the watcher, if `filePatterns` goes

The question raised against option 1 was a fair one: with grants as the only
filter, what stops a watcher melting down on a vendored tree or a `git clone`
landing inside an already-watched directory? Answered by measurement, and it
turned up three defects that had nothing to do with `filePatterns`.

### `filePatterns` was never what protected this

`BUILTIN_IGNORED_BASENAMES` (ADR-023) already excludes `node_modules`, `.git`,
`dist`, `build`, `target`, `.venv`, `__pycache__` and every hidden directory,
independently of grants, of `.gitignore` and of `filePatterns`. An `npm
install` into a watched tree was never going to be indexed.

Worth stating plainly, because it was assumed otherwise: **prag does not read
`.gitignore` at all.** Nothing parses it; the only mention in the code is that
the file `.gitignore` is itself exempt from the hidden-file rule so it can be
indexed as content. So "before a `.gitignore` is in place" is not the
dangerous window — the built-in list does not depend on one.

### Defect 1: the ignore list was applied after the walk, not during it

`chokidar.watch()` was called with no `ignored` option, so it enumerated and
placed an inotify watch on **every** directory in a project; `_shouldIgnore`
discarded the resulting events afterwards. The index was right and the cost
was not. Measured on a tree of 70,000 `node_modules` directories:

| | ready | RSS | kernel |
|---|---|---|---|
| as written | 4.9s | 590MB | **ENOSPC** |
| with `ignored` | 6ms | 71MB | clean |

ENOSPC is `fs.inotify.max_user_watches` exhausted (65,536 on a stock kernel,
and it is a **per-user** budget shared with every editor and language server
on the machine). Past that point an arbitrary subset of the tree has no watch,
and which subset is undefined.

So the melt-down intuition was right, but the trigger is not a missing
`.gitignore` — it is any large directory *count*, and `node_modules` was
reaching the kernel despite being on the ignore list. Fixed by passing the
predicate to chokidar, which prunes at the walk.
`daemontest:watcher-pruning.test.ts` asserts on the watch count rather than on
what got indexed, because the index looks identical either way: against the
old code it reports 304 watches where 4 are needed.

### Defect 2: a project was ignored for where it lived

`isBuiltinIgnored` tested every segment of the **absolute** path, so a project
that merely sat under a hidden or conventionally-named ancestor matched its
own ancestor's name. `prag watch ~/.config/notes` reported **`0 files` with an
empty `skipped` map** and indexed nothing — the worst shape a skip can take,
since ADR-023 requires skipped-by-design be visible and this was neither
indexed nor counted. Same for any project under a directory called `build`,
`target` or `dist`.

Now scoped to the project root: only the segments below it describe the
project's own layout. A mismatched root falls back to testing the whole path,
so the failure direction stays conservative.

### Defect 3: `node_modules` was not ignored on Windows

The predicate split on `/` only.

### What is still not bounded, and is a real decision

- **`vendor/`, `third_party/`, `Pods/`, `bower_components` are not on the
  built-in list**, so a vendored tree *is* walked, watched and indexed. This
  is the case the question was really about. Adding them is one line, but it
  is a policy change: Go projects routinely want `vendor/` indexed, and
  silently excluding it is exactly the "under-indexed without saying so" that
  ADR-023 forbids. **Maintainer's call** — the alternative is leaving it to an
  explicit `deny` grant, which already works and is visible in `prag grants`.
- **A large checkout into an already-watched directory skips the dry run.**
  ADR-023's confirmation threshold (20,000 files) is evaluated at `prag watch`.
  A `git clone` afterwards just produces events. With the pruning fix the
  common case (a dependency tree) costs nothing, but a genuine 50,000-file
  source import is admitted without a prompt. A post-registration growth check
  is not implemented and is not in any requirement.

### Watcher degradation is now visible

ENOSPC was previously a `console.error` on the daemon's stderr and nothing
else: `/health` stayed green and the project stayed `active` while coverage
was partial. `IngestionStats.watcherErrors` now carries the code per project,
and `prag status` prints `WATCHER DEGRADED (ENOSPC)` with the `sysctl` that
fixes it. Changes in unwatched directories are still picked up, by the
reconcile walk on each drain rather than immediately — that walk prunes
correctly, so it does not reintroduce the cost.

**None of this changes the answer on `filePatterns`.** Option 1 remains the
recommendation: the protection the question was worried about comes from the
built-in ignore list and from grants, both of which `filePatterns` would
duplicate rather than add to.
