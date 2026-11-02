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
  - coretest:fixtures.test.ts#fixtureInvariantSuite
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

In progress on purpose. The wiring and the invariants are done; the task's own first line —
"every documented ingestion behaviour has a fixture that exercises it" — is not satisfied while
PDF/DOCX and web fixtures have no ingestion path to exercise them.

- **"run in CI" — done, and CI is no longer the blocker.** `packages/core/test/fixtures.test.ts`
  spawns `test/fixtures/check-invariants.ts` as part of `npm test`, so a one-sided edit to
  `shared.ts` fails the build. Verified by breaking it: appending a line to
  `corpus/beta/src/shared.ts` produced `✖ cross-project dedup: shared.ts byte-identical`.
  Running it under `npm test` rather than only in CI is the point — the invariants are now
  enforced on every run whether or not a workflow file exists.
- **Large-file invariant — done.** `check-invariants.ts` used `ceil(len/4)`; it now counts with
  `approximateTokenizer()`, the same tokenizer the daemon uses for window sizing
  (`packages/daemon/src/daemon.ts:1704`), and asserts `large.ts` is **one** `function`, so more
  than one stored row can only come from unit splitting and not from chunking.
- **Fixture presence and shape — done.** The README's per-fixture promises are now asserted:
  `guide.md` has two heading levels, a bullet list, a fence and a table; `stats.R` contains
  roxygen `#'`; `web/firecrawl-stub.json` has `url`/`markdown`/`html` strings and
  `metadata.{title,description,statusCode}`.

Still open, and not fixable here (so the status stays `in_progress`):

- **PDF/DOCX extraction parity** needs `task:liteparse-document-pipeline.md`; the files are
  present and their presence is now asserted, but nothing extracts them.
- **The web stub is unconsumed** until ADR-024's fetch backend exists. Its field contract is
  pinned now so the ingestion task cannot quietly redefine it.

`check-invariants.ts` cannot carry a loom link: `test/fixtures/` is outside the `src` path
annotation (`design/document-model.mmd` maps `src` to `/packages`), so the links above point at
the harness that builds the fixtures and the suite that checks them.
