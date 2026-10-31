---
class: task
id: toolchain-spike-native-addons.md
title: Spike native addon support under Bun (LanceDB, ONNX, Tree-sitter)
status: todo
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
