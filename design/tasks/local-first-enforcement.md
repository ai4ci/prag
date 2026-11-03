---
class: task
id: local-first-enforcement.md
title: Implement hardware acceleration provider selection and local-first enforcement
status: in_progress
priority: medium
relates-to:
  - feature:local-first-runtime.md
tested-by:
  - daemontest:local-first-egress.test.ts
---
## Objective
Implement hardware-configurable acceleration provider selection for the local ONNX
embedding runtime, and make the local-first guarantee (ADR-024) independently
verifiable.

## Requirements
- Detect available acceleration providers (CUDA, WebGPU, DirectML) at daemon startup; honor `PRAG_EMBEDDING_DEVICE`.
- Automatic graceful fallback to CPU SIMD execution when no dedicated accelerator is present or initialization fails.
- Log the selected provider on startup (visible via `prag daemon status`).
- Add a CI/test check (e.g. network-call interception in tests) asserting that a
  normal index+search cycle over **local** content makes zero outbound network
  connections. Local content here means `file://` grants only; the check is not
  weakened to "localhost only", and it holds even when a web backend is configured,
  since serving a local query must never touch the backend.
- Report the active web backend (id + endpoint) in `GET /health` and `prag status`,
  and reflect it in the local-first assertion above: the assertion is about the
  local path, not about the process never having a network route.
- Add a test that a configured-but-unreachable web backend cannot make a local
  search fail or emit a request (no fallback, no retry storm, per ADR-024).

## Implementation status 2026-11-03

Partially complete. The local-first guarantee and the device selection are
done; the two web-backend requirements are blocked on work that does not exist
yet.

- **`PRAG_EMBEDDING_DEVICE` — DONE.** It was documented in
  `env-and-storage-paths.md` and read by nobody: `OnnxEmbeddingProvider` had a
  `device` option that nothing populated, so every install silently ran on CPU
  whatever the user configured. The `onnx:` provider factory now reads it.
- **Graceful CPU fallback — DONE.** A device that fails to initialise falls
  back to CPU rather than failing startup, and says so on stderr. Silently
  running an order of magnitude slower than the user believes is its own
  failure, so it is logged, not swallowed.
- **Selected provider is visible — DONE.** `activeDevice` (what is *in use*,
  not what was asked for) is reported by `GET /health` as `embeddingDevice`
  and printed by `prag status` and the daemon's startup line.
- **Zero-egress assertion — DONE.** `daemontest:local-first-egress.test.ts`
  runs a full watch -> sync -> search cycle over `file://` content and asserts
  no non-loopback socket connection or DNS lookup occurs. The hook is at the
  socket layer rather than at `fetch`, because a native-addon telemetry call
  or a model download would bypass `fetch` entirely and those are the paths
  worth catching. It is not weakened to "localhost only": loopback is allowed
  because the daemon is a loopback service, but anything leaving the machine
  fails.

  The suite also tests the watcher itself against a TEST-NET-1 address, which
  is what makes the first assertion mean anything. That second test earned its
  place immediately: the first version of the hook read `args[0].host`, but
  Node calls `Socket.prototype.connect` with the normalised array
  `[options, cb]`, so it silently recorded nothing and the egress assertion
  passed vacuously.

### Blocked, not done

- **Report the active web backend in `GET /health` and `prag status`.**
- **Test that a configured-but-unreachable web backend cannot fail a local
  search or emit a request (ADR-024).**

Both need a web backend to exist. `task:web-fetch-backend-interface.md` has
not started, and `/projects/watch` currently refuses any non-`file://` URI with
`CRAWL_BACKEND_REQUIRED`. The egress test above is written so that adding a
backend does not weaken it: it asserts on the local path, which must stay
silent even once a backend is configured.

Hardware acceleration beyond honouring the variable -- probing for CUDA,
WebGPU or DirectML availability and choosing among them -- is not implemented.
`device` is passed to Transformers.js, which does its own dispatch; there is no
independent detection. Recorded rather than guessed at: what counts as
"detecting" a provider depends on whether the project wants to prefer an
accelerator automatically or only ever honour an explicit setting, and that is
a decision, not an implementation detail.
