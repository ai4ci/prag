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

## Verification
- With a large repository actively indexing, `POST /search` p99 stays inside the 100ms interactive budget (ADR-005). Measure under load; this is the whole point of the task.
- Parsing a single very large file does not produce a measurable stall in concurrent `/health` responses.
- Resident memory does not scale with `workerPoolSize` — assert exactly one copy of the model is loaded at pool sizes 1 and 4.
- Killing a worker mid-parse leaves the daemon serving and the affected file marked errored.
