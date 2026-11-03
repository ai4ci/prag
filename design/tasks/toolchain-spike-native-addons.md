---
class: task
id: toolchain-spike-native-addons.md
title: Spike native addon support under Bun (LanceDB, ONNX, Tree-sitter)
status: done
priority: high
relates-to:
  - feature:test-harness-and-fixtures.md
blocks:
  - task:core-database-schemas.md
  - task:test-environment-isolation.md
---
## Objective
Prove that the three native NAPI modules `prag` depends on actually **run** under Bun before any implementation is written against that assumption (ADR-020). Bun's N-API support is good but incomplete, and these three are exactly the kind of module that exposes the gaps. Finding a gap after the daemon exists is expensive; finding it in a throwaway script is an afternoon.

Installing cleanly is not the test. Each module must execute its real workload.

## Requirements
Write a single throwaway script, run it under Bun, and record the result in this task:
- **LanceDB (`@lancedb/lancedb`, Rust NAPI):** create a table with a fixed-dimension vector column, insert a handful of rows, run a vector query and a scalar-predicate filter, create a BM25 FTS index and query it, then `optimize()`. FTS and compaction are the paths most likely to be missing.
- **ONNX (`onnxruntime-node` via Transformers.js):** load `Xenova/bge-small-en-v1.5` and run one embedding pass. Confirm the output dimension is 384. Record whether inference is dispatched asynchronously off the main loop or blocks it — this is the input ADR-021 needs for the concurrency decision.
- **Tree-sitter:** parse one file with each of the TypeScript, Python and R grammars and walk the resulting AST. Record which binding was used (native vs WASM) and whether parsing is synchronous.
- **`worker_threads` under Bun:** if the concurrency decision lands on a worker pool, confirm a worker can be spawned, can load whichever of the above modules it needs, and can transfer a `Float32Array` back without copying.

## Verification
- All four sections run to completion under Bun with no crash, no silent fallback, and no missing-symbol error.
- Record the measured cost of: one embedding pass, one vector query, one Tree-sitter parse. These numbers feed the 100ms interactive budget (ADR-005) and the batch sizing in `embedding.batchSize`.
- If any section fails, record exactly what failed and switch `@prag/daemon` to Node per ADR-020's fallback, keeping Bun for the CLI and `bun test`. Update ADR-020 with the outcome either way — an accepted ADR resting on an unverified assumption is worse than one that records a known limitation.

## Outcome 2026-11-03: superseded, not run

Closed without running. The spike existed to gate a decision "before any
implementation is written against that assumption" (ADR-020 §5). The
implementation is written, and it went to Node -- this ADR's own §6 fallback --
so the question the spike would answer no longer has a decision attached to it.

`ADR-020` is amended to record Node for both daemon and CLI, and `bun.lock` is
deleted. The reasoning for not putting Bun under the daemon is there: the
daemon is long-lived, so Bun's start-up advantage is worth nothing to it, while
all three of its native modules (`@lancedb/lancedb`, `onnxruntime-node`,
`@kreuzberg/tree-sitter-language-pack`) are the kind that expose N-API gaps. It
would carry the risk and collect no benefit.

The two tasks this blocked -- `task:core-database-schemas.md` and
`task:test-environment-isolation.md` -- were completed on Node while this
remained open, which is itself the evidence that the gate had stopped
functioning as one.

**If Bun returns, it returns for the CLI**, where there are no native modules
and the measured start-up gap is real (Bun ~100ms vs Node ~190-240ms against
ADR-005's 100ms budget). That case needs none of the four sections above; it
needs a client-safe entry point in `@prag/core`, because the CLI currently
imports the barrel and so pulls LanceDB into its graph. Recorded in ADR-020.
