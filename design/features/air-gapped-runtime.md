---
class: feature
id: air-gapped-runtime.md
title: Air-Gapped Local Runtime and Hardware Acceleration
status: accepted
priority: high
area: core
guided-by:
  - adr://ADR-006.md
  - adr://ADR-012.md
---
## Overview
Self-hosted, local-first runtime with zero telemetry. By default (no web URIs registered) all embeddings, parsing, and storage remain strictly inside the local workstation hardware perimeter and zero outbound network calls occur. When web URIs are granted, outbound fetches use a self-hosted Firecrawl instance or a headless-fetcher fallback — never an external LLM or cloud indexing service (see ADR-012 for the precise scope of this guarantee).

## Requirements
- No telemetry, analytics, or usage reporting calls, ever, regardless of configuration.
- Zero outbound network calls in the default configuration (no web URIs granted).
- Outbound network calls occur only for URIs the user explicitly grants via `prag watch <https-uri>` (see `web-and-nonlocal-content.md`); no external cloud LLM dependency is required for core indexing/search.
- Hardware-configurable acceleration providers:
  - GPU / CUDA / WebGPU for swift local inference when hardware is present.
  - Automatic graceful fallback to optimized CPU SIMD loops when dedicated acceleration is absent.
- Compact local embedding models (e.g. `Xenova/bge-small-en-v1.5`, `nomic-embed-text`) with ~130MB local disk footprint.