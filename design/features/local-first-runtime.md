---
class: feature
id: local-first-runtime.md
title: Local-First Runtime, Hardware Acceleration and Egress Transparency
status: in_progress
priority: high
area: core
guided-by:
  - adr:ADR-006.md
  - adr:ADR-024.md
---
## Overview
Content that lives on the user's machine stays on the user's machine. Parsing,
chunking, hashing, embedding and storage of local content all execute on local
hardware, and a complete index-and-search cycle over local content works with the
network unreachable — not merely unconfigured. This is the guarantee, and it is
unconditional.

Web fetching is a separate, explicitly granted path and is **not** covered by it
(ADR-024). It may be served by a hosted third-party backend; which backend is in
use is always visible in status output. The earlier "100% air-gapped" framing is
retired: it described the local half correctly and the web half falsely.

## Requirements
- No telemetry, analytics, or usage reporting calls, ever, regardless of configuration.
- A local index-and-search cycle completes with the network **unreachable**. The
  CI check asserts zero outbound connections, not "zero connections to
  non-localhost hosts" — nothing in the local path may even attempt egress.
- No local content, and no query derived from local content, is transmitted. This
  holds even when a web backend is configured and running.
- Outbound network calls occur only for URIs the user explicitly grants via
  `prag watch <https-uri>` (see `web-and-nonlocal-content.md`), through the
  configured web-fetch backend.
- The active web backend (identifier + endpoint) is reported by `prag status` and
  `GET /health`, so the current egress path is inspectable without reading config.
- Configuring a hosted web backend never licenses a hosted inference endpoint:
  embedding stays local (ADR-006). Backend choice and inference location are
  independent axes.
- Hardware-configurable acceleration providers:
  - GPU / CUDA / WebGPU for swift local inference when hardware is present.
  - Automatic graceful fallback to optimized CPU SIMD loops when dedicated acceleration is absent.
- Compact local embedding models (e.g. `Xenova/bge-small-en-v1.5`, `nomic-embed-text`) with ~130MB local disk footprint.
