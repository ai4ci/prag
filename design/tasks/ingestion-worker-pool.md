---
class: task
id: ingestion-worker-pool.md
title: Implement the ingestion worker pool with main-thread embedding and writes
status: done
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
  - daemontest:ingestion-latency.test.ts
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

Complete as of 2026-11-03.

- **Pool reaches production — DONE.** `workerPoolSize` is read and honoured
  (`??`, so the documented `0` means "watching disabled").
- **Vectorised-unit windowing — DONE.** `splitVectorUnits` runs on the
  ingestion path and `vector_pool` is keyed `(chunkHash, unitIndex)`; the
  literal `unitIndex: 0` is gone (ADR-014).
- **Single-writer invariant — DONE.** No worker holds a database handle.
- **Crash containment — DONE.** `issue:worker-pool-double-respawn.md` resolved.
- **Concurrency cap — DONE.** One in-flight job per slot with an overflow
  queue, bounded by pool size.
- **Verification — MEASURED.** `daemontest:ingestion-latency.test.ts` exercises
  the claim the pool exists for ("synchronous parsing cannot stall the
  `/search` request path") by sampling `/health` while a 120-file tree is
  parsed and embedded:

  | | p50 | p99 |
  |---|---|---|
  | idle | 0.1ms | 0.4ms |
  | ingesting 120 files | 0.1ms | 4.6-6.1ms (3 runs) |

  The event loop keeps turning: ~6000 requests complete during the ingest. The
  assertion is a generous absolute bound (p99 < 1000ms) rather than a tight
  one, because a tight threshold on a shared runner measures the runner. It is
  a guard against parsing moving back onto the main thread, which would show up
  as seconds; the printed percentiles are what makes a smaller regression
  legible.

### Transferables: not applicable as written, and not worth it

The requirement asks to pass "large text buffers and `Float32Array` vectors
across the thread boundary as transferables where the runtime supports it".

The `Float32Array` half is moot by construction: ADR-021 keeps embedding on the
main thread, so no vector ever crosses the boundary. A worker returns
`ProcessResult`, which is chunk text and metadata.

The text half is possible -- encode to an `ArrayBuffer` in the worker, transfer,
decode on the main thread -- but strings are not themselves transferable, so it
trades a structured-clone copy for an encode plus a decode, and is only a win
above some payload size. The measurement above says the copy is not where the
time goes: p99 serving latency under a full ingest is ~5ms. Implementing it now
would be an unmeasured optimisation against a cost that has not been shown to
exist.

Recorded as deliberately not done. Revisit if a profile ever shows
structured-clone of chunk text as a real cost -- the measurement harness to
prove it is now in the repository.
