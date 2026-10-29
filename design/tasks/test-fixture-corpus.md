---
class: task
id: test-fixture-corpus.md
title: Maintain the test fixture corpus and git fixture builder
status: todo
priority: high
relates-to:
  - feature://test-harness-and-fixtures.md
addressed-by:
  - src://daemon/src/test-harness.ts
---
## Objective
Keep `test/fixtures/` a complete and honest set of inputs: every documented ingestion behaviour has a fixture that exercises it, and every fixture's invariant is checked rather than assumed.

The corpus and the builder script exist (`test/fixtures/`, see its `README.md` for the per-fixture table). This task covers wiring them into the harness and guarding their invariants.

## Requirements
- `test/fixtures/build-git-fixtures.mjs <targetDir>` is invoked by the harness during setup, against a directory inside the test `PRAG_ROOT` (ADR-019). It is idempotent, has no dependencies, and pins author/committer identity and dates so commit hashes are stable.
- Git fixtures are **built, never committed**: a nested `.git` directory does not survive being committed to this repository.
- Add an invariant check, run in CI, asserting the properties the fixtures depend on:
  - `corpus/alpha/src/shared.ts` and `corpus/beta/src/shared.ts` are byte-identical (cross-project dedup).
  - `corpus/reformat/original.ts` and `reformatted.ts` differ only in whitespace (ADR-010 hash invariance).
  - `corpus/alpha/src/large.ts` still contains a single function exceeding `embedding.maxVectorUnitTokens`, so it still produces several vectorised units (ADR-014). This one silently stops testing anything if the default is raised or the file is trimmed.
  - `build-git-fixtures.mjs` produces identical commit SHAs across two consecutive builds.
- Extend the corpus when a new ingestion path is added (a new Tree-sitter grammar, a new document format), and record what the new fixture proves in `test/fixtures/README.md`.

## Verification
- The invariant check fails if `shared.ts` is edited in only one of the two projects.
- The invariant check fails if `large.ts` is trimmed below the vectorised-unit threshold.
- Two consecutive builds into different directories produce identical `git rev-parse HEAD` and `git rev-parse feature-x` for `alpha`.
