---
class: feature
id: test-harness-and-fixtures.md
title: Test Harness, Environment Isolation, and Fixture Corpus
status: accepted
priority: high
area: core
guided-by:
  - adr://ADR-019.md
  - adr://ADR-015.md
  - adr://ADR-016.md
  - adr://ADR-017.md
---
## Overview
Automated tests must run against a `prag` instance that shares nothing with the developer's own installation: its own data directory, config, runtime files, port and logs. Two operations in the accepted design are destructive — `prag reembed` drops every content table (ADR-015) and `prag prune --gc-chunks` deletes and compacts (ADR-017) — so an isolation failure is not a flaky test, it is the loss of the developer's real index. Isolation is therefore a single explicit switch with an assertable result, not four variables a harness is trusted to remember.

## Environment Isolation (ADR-019)
- **`PRAG_ROOT`**: sets all four base directories at once -- `<root>/data`, `<root>/config`, `<root>/state`, `<root>/state/logs`. Individually-set `PRAG_DATA_DIR`/`PRAG_CONFIG_DIR`/`PRAG_RUN_DIR`/`PRAG_LOG_DIR` still take precedence; unset ones derive from the root instead of falling back to XDG paths.
- **`PRAG_PORT=0`**: binds a kernel-assigned ephemeral port, written to `daemon.port` as usual. The only supported way to run daemons in parallel. Clients read the port from `daemon.port`, never guess it (ADR-016's no-scanning rule stands).
- **`PRAG_NO_SPAWN=1`**: the CLI never lazily auto-spawns; it fails immediately instead. The harness owns daemon lifetime, so a crashed test cannot leave an orphaned detached daemon holding a port.
- **`PRAG_EMBEDDING_MODEL=fake:<dim>`**: selects the deterministic built-in embedder (vector derived from a hash of the text). Offline, instant, reproducible, and pinned in the ADR-015 sidecar like any real model.

## Harness Lifecycle Contract
```text
setup:    mkdtemp -> PRAG_ROOT=<tmp> PRAG_PORT=0 PRAG_NO_SPAWN=1 PRAG_EMBEDDING_MODEL=fake:384
          start @prag/daemon
          poll GET /health until status=ok
          ASSERT health.root === <tmp>          <-- guard before any destructive call
          read port from <tmp>/state/daemon.port, token from <tmp>/state/daemon.token
exercise: POST /grants, write fixture files, POST /sync (drain barrier), assert
teardown: POST /shutdown, wait for exit, rm -rf <tmp>
```

- `GET /health` reports `root`, `dataDir`, `configDir` and `runDir` so the isolation assertion above is possible at all.
- `POST /sync` is a **drain barrier**: it returns only once the ingestion queue is empty, pending debounces and cooldown leases have been forced, and all writes are committed. Every assertion about indexed state is made after a `/sync`, never after a sleep.
- Teardown is unconditional: a failed test still shuts the daemon down and deletes the root.

## Test Tiers
| Tier | Embedder | Asserts | Expected cost |
|---|---|---|---|
| Unit / integration (default) | `fake:384` | Plumbing: chunk counts, vectorised-unit counts, dedup, branch pointers, project scoping, grant evaluation, GC, auth | Fast, offline, deterministic |
| Retrieval quality (opt-in) | Real ONNX model (ADR-006) | Ranking and relevance only | Slow, needs model weights |

Splitting the tiers is what lets `air-gap-hardware-provider.md`'s "zero outbound connections during index+search" assertion hold on a cold machine: the default tier never downloads a model.

## Fixture Corpus
Fixtures live at `test/fixtures/` and are framework-agnostic files plus one builder script. Each exists to prove a specific documented behaviour:

| Fixture | Proves |
|---|---|
| `corpus/alpha/src/math.ts`, `analysis.py`, `stats.R` | Tree-sitter structural chunking across the three named grammars |
| `corpus/alpha/src/large.ts` | One oversized chunk becomes several vectorised units under a single `chunkHash` (ADR-014) |
| `corpus/alpha/src/shared.ts` == `corpus/beta/src/shared.ts` (byte-identical) | Cross-project CAS dedup: one `chunks_pool` row, two projects |
| `corpus/reformat/original.ts` vs `reformatted.ts` (whitespace-only diff) | Whitespace-normalized hashing yields an identical `chunkHash`, bypassing re-embedding (ADR-010) |
| `corpus/alpha/docs/guide.md`, `documents/sample.{md,pdf,docx}` | Layout-preserving document chunking via LiteParse |
| `corpus/plain/` (no `.git`) | The `$default` branch sentinel for non-git projects |
| Built `.env` and `node_modules/` noise | Built-in ignore grants exclude them (ADR-009) |
| `web/firecrawl-stub.json` | Web ingestion with zero outbound network calls |

### Git Fixtures
`test/fixtures/build-git-fixtures.mjs <targetDir>` assembles the git repositories at setup time; they are not committed, because a nested `.git` directory does not survive being committed to this repository. The builder pins author and committer identity and dates so commit hashes are stable across runs, and produces:
- `alpha` — a repo on `main`, plus a `feature-x` branch that leaves one file **identical** (shared `fileVersionId`, zero re-embedding), **modifies** one (new `fileVersionId`), **deletes** one (pointer removed on that branch only), and **adds** one (present on `feature-x` only). This is the whole of ADR-002's branch behaviour in one fixture.
- `beta` — a second repo sharing a byte-identical file with `alpha`.
- `plain` — a non-git directory.
- Untracked `.env` and `node_modules/junk/index.js` inside `alpha` for exclusion assertions.
