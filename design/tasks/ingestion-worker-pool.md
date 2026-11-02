---
class: task
id: ingestion-worker-pool.md
title: Implement the ingestion worker pool with main-thread embedding and writes
status: in_progress
priority: high
relates-to:
  - feature:background-worker-queue.md
blocks:
  - task:daemon-ingestion-queue.md
addressed-by:
  - src:daemon/src/worker-pool.ts#WorkerPool
  - src:daemon/src/worker-pool.ts#ProcessResult
  - src:daemon/src/ingestion-worker.ts#WorkerInput
  - src:daemon/src/ingestion-worker.ts#WorkerOutput
tested-by:
  - daemontest:worker-pool.test.ts#workerPoolSuite
---
## Objective
Implement the concurrency split of ADR-021 so synchronous parsing cannot stall the `/search` request path.

## Requirements
- Add a `worker_threads` pool in `@prag/daemon` owning: file read, Tree-sitter / LiteParse parse, chunk boundary detection, whitespace normalization (ADR-010), `chunkHash` computation, and vectorised-unit windowing (ADR-014). A worker returns chunk records only — text, hash, unit boundaries, scope annotation.
- The main thread keeps HTTP/MCP serving, ONNX embedding, and **every** LanceDB write. No worker is given a database handle, so ADR-005's single-writer invariant holds structurally rather than by convention.
- `ingestion.workerPoolSize`, default `1`. Do not raise the default without the measurements from `toolchain-spike-native-addons.md`.
- Never load the embedding model inside a worker (~130MB of weights each, ADR-006).
- Transfer large text buffers and `Float32Array` vectors across the thread boundary as transferables where the runtime supports it, rather than structured-cloning copies.
- Worker crashes must be contained: a failed parse marks that file as errored, is logged with the URI, and does not take down the pool or the daemon.
- Honour the ADR-023 concurrency cap so ingestion cannot saturate the machine.

## Implementation status

Reverted from `done`: the thread split exists and the single-writer invariant holds, but the
pool is not reachable in production, unit windowing is absent, and the crash path is broken.

- **Pool is dead code in production — MISSING.** `loadConfig()` (`packages/daemon/src/daemon.ts:51-59`)
  never reads `config.ingestion`, and `daemon.ts:93` only constructs a `WorkerPool` when
  `poolSize !== undefined && > 0`; nothing sets it, so a spawned daemon has no pool at all. There
  is no default of 1 either — `IngestionConfig.poolSize ?? 1` (`packages/daemon/src/ingestion-queue.ts:58`)
  is not what `WorkerPool` is constructed from. `ingestion.workerPoolSize` exists only as a type
  field (`packages/core/src/paths.ts:101`). Compounded by `issue:daemon-entry-point-has-no-main.md`.
- **Vectorised-unit windowing — MISSING.** The worker returns whole chunks
  (`packages/daemon/src/ingestion-worker.ts:31-51` → `chunkFile`, `packages/core/src/chunker.ts:153`)
  and ingestion writes exactly one vector per chunk with a literal `unitIndex: 0`
  (`packages/daemon/src/daemon.ts:240`). ADR-014's multi-unit chunking is unimplemented, so large
  functions are embedded truncated rather than split — and `vector_pool`'s composite PK stays
  unexercised (see `task:lancedb-init-scripts.md`).
- **Transferables — MISSING.** `grep transferList packages/daemon/src` → 0 matches; both
  `postMessage` calls (`worker-pool.ts:116`, `ingestion-worker.ts:51`) structured-clone. Vectors
  never cross the boundary at all, since embedding happens on the main thread.
- **Crash containment — PARTIAL, and broken.** The pool survives and logs with the URI
  (`worker-pool.ts:157-166`), but no errored state is persisted (`grep errored packages/daemon/src`
  → 0; `file_mapping` has no status column, `packages/core/src/database.ts:83-91`) and the queue
  path swallows the failure into `console.error` (`ingestion-queue.ts:238-240`). Worse, the respawn
  logic double-spawns and can dispatch to a dead worker, hanging the request —
  `issue:worker-pool-double-respawn.md`.
- **Concurrency cap — PARTIAL.** Concurrency is bounded by pool slots
  (`worker-pool.ts:73-77`), but the configured size is never read (above) and
  `embedding.batchSize` is ignored: `daemon.ts:208` embeds every chunk of a file in one
  `embedBatch` call.
- **Verification — 0 of 4 measured.** No p99-under-load measurement, no `/health` stall test, no
  memory/model-copy assertion at pool sizes 1 vs 4, no kill-mid-parse test
  (`grep "kill|terminate|respawn" packages/daemon/test/` → 0 matches).

Satisfied: read/parse/chunk-boundary/whitespace-normalization/`chunkHash` in the worker
(`ingestion-worker.ts:31-51`, `chunker.ts:83,95,153`); main thread keeps HTTP/MCP, embedding and
**every** LanceDB write, with no DB handle in the worker (`ingestion-worker.ts:7-9` imports only
`chunkFile`/`detectLanguageFromPath`; writes at `daemon.ts:205-247,646`) — ADR-005's single-writer
invariant holds structurally; no model load in workers.

Remaining: wire `ingestion.workerPoolSize` with default 1 through `loadConfig`; add unit windowing
and real `unitIndex` values; use transferables; fix the respawn defects and persist an errored
state; honour `batchSize`; add the four verification measurements.

## Verification
- With a large repository actively indexing, `POST /search` p99 stays inside the 100ms interactive budget (ADR-005). Measure under load; this is the whole point of the task.
- Parsing a single very large file does not produce a measurable stall in concurrent `/health` responses.
- Resident memory does not scale with `workerPoolSize` — assert exactly one copy of the model is loaded at pool sizes 1 and 4.
- Killing a worker mid-parse leaves the daemon serving and the affected file marked errored.
