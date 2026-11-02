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

Re-audited 2026-11-02. Still `in_progress`, but for narrower reasons than the previous
audit recorded — its two blocking items are both closed.

- **Pool reaches production — DONE.** `workerPoolSize` is read and honoured
  (`??`, so the documented `0` means "watching disabled" rather than being
  overridden by a default).
- **Vectorised-unit windowing — DONE.** `splitVectorUnits` is applied on the
  ingestion path and `vector_pool` rows are keyed `(chunkHash, unitIndex)`; the
  literal `unitIndex: 0` is gone, so large functions are split rather than
  embedded truncated (ADR-014).
- **Crash containment — DONE.** `issue:worker-pool-double-respawn.md` is
  resolved: a dead worker is replaced in its slot and no dead index is left in
  the idle list.
- **Concurrency cap — DONE.** One in-flight job per slot with an overflow
  queue, so concurrency is bounded by pool size (`worker-pool.ts:99-113`).

Outstanding:

- **Transferables — MISSING.** `grep transferList packages/daemon/src` → no
  match; worker payloads are structured-cloned rather than transferred.
- **Verification — 0 of 4 measured.** No p99-under-load measurement, no
  `/health` stall test under ingestion load. The functional behaviour is
  tested; the performance claims in the requirements are not.
