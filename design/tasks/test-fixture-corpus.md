---
class: task
id: test-fixture-corpus.md
title: Maintain the test fixture corpus and git fixture builder
status: in_progress
priority: high
relates-to:
  - feature:test-harness-and-fixtures.md
addressed-by:
  - src:daemon/src/test-harness.ts
  - src:daemon/src/test-harness.ts#buildFixtures
tested-by:
  - daemontest:ingestion-e2e.test.ts#daemonWithIngestionSuite
  - clitest:e2e.test.ts#cLIEndToEndSuite
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

## Implementation status

Reverted from `done`: the builder and all four invariants are written and correct, but
nothing executes them, so the invariants are currently decorative.

- **"run in CI" — MISSING.** No `.github/` exists in the repo (sandbox-protected; see
  the CI todo), `grep -rn check-invariants package.json packages/*/package.json` → 0
  matches, and no `*.test.ts` imports or spawns `test/fixtures/check-invariants.ts`
  (`grep -rn check-invariants packages/` → 0). Its only reference is its own docstring.
  A one-sided edit to `shared.ts` therefore breaks no build.
- **Large-file invariant is an estimate.** `test/fixtures/check-invariants.ts:64-66`
  approximates tokens as `ceil(len/4)` rather than tokenising, and never asserts the
  "single function" property the requirement names.
- **Documented-but-unconsumed fixtures.** `test/fixtures/README.md:23-25` lists
  `documents/sample.pdf`, `documents/sample.docx` and `web/firecrawl-stub.json`, and the
  files exist, but `check-invariants.ts:136-141` checks only `sample.md`; nothing
  validates PDF/DOCX extraction parity or the stub's fields, and no ingestion code reads
  any of them (`grep -rn firecrawl packages/*/src` → 0).

Satisfied: builder invoked from the harness inside the test root, idempotent, pinned
identity/dates (`packages/daemon/src/test-harness.ts:27-40`,
`test/fixtures/build-git-fixtures.mjs:16-24,99-101`); git fixtures built not committed
(`git ls-files test/fixtures | grep -c '\.git/'` → 0); all four invariant assertions
written (`check-invariants.ts:36-105`), including the two-build SHA equality that
Verification #3 asks for.

Remaining: wire `check-invariants.ts` into `npm test` (a test that spawns it is enough
until CI exists), tokenise the `large.ts` check, and either consume the PDF/DOCX/web
fixtures or drop them from the README table.
