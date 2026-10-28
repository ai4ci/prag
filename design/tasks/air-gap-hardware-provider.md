---
class: task
id: air-gap-hardware-provider.md
title: Implement hardware acceleration provider selection and air-gap enforcement
status: todo
priority: medium
relates-to:
  - feature://air-gapped-runtime.md
---
## Objective
Implement hardware-configurable acceleration provider selection for the local ONNX embedding runtime, and make the air-gap guarantee (ADR-012) independently verifiable.

## Requirements
- Detect available acceleration providers (CUDA, WebGPU, DirectML) at daemon startup; honor `PRAG_EMBEDDING_DEVICE`.
- Automatic graceful fallback to CPU SIMD execution when no dedicated accelerator is present or initialization fails.
- Log the selected provider on startup (visible via `prag daemon status`).
- Add a CI/test check (e.g. network-call interception in tests) asserting that with no web URIs registered, the daemon process makes zero outbound network connections during a normal index+search cycle.