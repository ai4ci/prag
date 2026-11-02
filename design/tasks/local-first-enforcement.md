---
class: task
id: local-first-enforcement.md
title: Implement hardware acceleration provider selection and local-first enforcement
status: todo
priority: medium
relates-to:
  - feature:local-first-runtime.md
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
