---
class: task
id: workspace-isolation-enforcement.md
title: Enforce project-scoped query and storage isolation across workspaces
status: done
priority: medium
relates-to:
  - feature:workspace-isolation.md
tested-by:
  - coretest:ignore-scope.test.ts#ignoreScopeSuite
  - daemontest:watcher-pruning.test.ts#watcherPruningSuite
  - daemontest:growth-breaker.test.ts#growthBreakerSuite
  - daemontest:growth-breaker.test.ts#growthBreakerDaemonSuite
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

## 2026-11-03: the runtime growth bound, implemented

The second gap above -- "a large checkout into an already-watched directory
skips the dry run" -- is closed. `ADR-023`'s confirmation threshold now has a
runtime counterpart, `ingestion.growth`, and the two share a default so that
"20,000 files is enough to ask about" does not mean two different things
depending on whether the files arrived before or after registration.

### Mechanism

A rolling window per project, counted in `_checkFile` -- the single admission
gate -- on files that passed every other check. Over `maxFiles` or `maxBytes`
within `windowMs` and the project is **held**: `projects.status = 'paused'`.

Counted there rather than at `_onEvent` because that is where the real byte
size is known and where only files that would actually have been parsed and
embedded are counted; a flood of denied or binary files cannot trip it.

### Held, not refused

The distinction is the whole design. Refusing the files would leave the
project silently under-indexed, which ADR-023 forbids. A hold keeps the files
on disk and the index untouched, and `prag resume` re-walks and indexes them,
so there are exactly two ways out and both are one command:

```sh
prag resume <project>                        # yes, I meant that
prag deny <path> && prag resume <project>    # no, exclude it first
```

Pause/resume already existed end to end -- admission gate, endpoints, status
column, and a resume that forces a full re-walk which re-reads but does not
re-embed unchanged content. The breaker is a new trigger for an existing
mechanism rather than a new mechanism, which is why it is small.

### Four things that had to be right

- **The breaker must not fire on a walk the user consented to.** Suppressed
  for the initial scan (behind `prag watch`'s prompt) and for the rescan that
  `prag resume` triggers -- otherwise resume is an infinite loop: resume,
  re-walk, trip, hold. Arming happens when the *first flush completes*, not on
  chokidar's `ready`: `ready` means the walk finished, and its files have not
  yet been through admission. Arming on `ready` held every project the moment
  it was registered, which a test caught.
- **It must fire once per burst.** The rest of the burst is already in the
  dirty set when it trips and the daemon's pause is a database write, so
  without in-memory suppression every remaining file raised its own breach.
- **Admission stops immediately, not when the pause lands.** `_checkFile`
  checks the in-memory breach before `isPaused`. Without it, the tens of
  milliseconds the status write takes were spent parsing and embedding the
  rest of the burst -- precisely the work being prevented. Measured on a
  30-file drop: 30 files indexed before, 4 after.
- **Steady work must never accumulate into a hold.** The window is a reset
  bucket, so a long-lived busy project cannot drift into one. A burst
  straddling two buckets is measured as two part-bursts, which in principle
  lets 2x through; accepted, because the accident does not stop at the bucket
  boundary and trips the next one.

### Where it points

`GrowthBreach.topDirectory` names the immediate child of the project root
that contributed most of the bytes, and only when the volume is genuinely
concentrated there (over half). That is almost always the directory that was
moved in, so the remedy is a single `prag deny` rather than a hunt. It is
offered in the message, not acted on: the subtree cannot be identified
reliably, only guessed at, so the whole project is held and the guess is
advice.

### What this does not do

- It does not bound a project that is large **at registration** -- that is
  `watchConfirmThreshold`'s job, and it already prompts.
- It does not make the hold granular. A held project stops indexing entirely,
  including the source the user actually cares about, until they resume. The
  alternative -- holding only the offending subtree -- needs an identification
  that cannot be made reliably.
- It still does not decide whether `vendor/` and `third_party/` belong on the
  built-in ignore list. That remains open above; the breaker makes getting it
  wrong survivable rather than unnecessary.


## Closed 2026-11-03: `filePatterns` dropped, and the real gaps fixed

The maintainer chose option 1. `filePatterns` is removed from
`feature:workspace-isolation.md` with the reasoning recorded there, so
requirement 3 has nothing left to verify: grants are the single filter, as
ADR-009 intended.

The question it prompted -- "then what stops the indexer being handed
gigabytes?" -- was the valuable part, and the answer turned out to be four
defects and one missing bound, all recorded above and all fixed:

1. chokidar walked and watched ignored subtrees, discarding the events
   afterwards (ENOSPC on a large tree).
2. `isBuiltinIgnored` tested the absolute path, so a project under a hidden
   or conventionally-named ancestor indexed nothing and said nothing.
3. `node_modules` was not ignored on Windows.
4. A watcher degraded by ENOSPC was invisible: `/health` stayed green.
5. No runtime growth bound existed at all; `ingestion.growth` is it.

`vendor/`, `third_party/`, `Pods/` and `bower_components` stay indexable, by
decision: Go projects routinely want `vendor/` searchable, silently excluding
it is the under-indexing ADR-023 forbids, and `prag deny` is explicit and
visible. The growth breaker makes getting that wrong survivable.
