---
class: feature
id: air-gapped-runtime.md
title: Air-Gapped Local Runtime and Hardware Acceleration
status: accepted
priority: high
area: core
guided-by:
  - adr://ADR-006.md
---
## Overview
100% air-gapped runtime with zero telemetry or remote API calls. All embeddings, parsing, and storage remain strictly inside the local workstation hardware perimeter.

## Requirements
- Complete air-gap guarantee: no outbound network calls, analytics, telemetry wrappers, or external cloud LLM dependencies.
- Hardware-configurable acceleration providers:
  - GPU / CUDA / WebGPU for swift local inference when hardware is present.
  - Automatic graceful fallback to optimized CPU SIMD loops when dedicated acceleration is absent.
- Compact local embedding models (e.g. `Xenova/bge-small-en-v1.5`, `nomic-embed-text`) with ~130MB local disk footprint.