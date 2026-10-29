---
class: issue
id: chunk-pool-disk-usage-growth.md
title: No budget or alert for chunks_pool disk usage growth
status: open
priority: low
---
## Problem
`chunks_pool` and `vector_pool` grow unbounded until a user or agent explicitly runs `prag prune --gc-chunks`. In a content-addressable store, identical content across branches and projects compresses well, but unique content accumulates without any disk usage budget, warning, or alert.

There is no guidance on:
- What "too large" means for the chunk pool vs the actual indexed file count.
- Whether the daemon should warn when `chunks_pool` disk usage exceeds a threshold.
- How a user discovers they need to run `prune --gc-chunks` without manually inspecting `prag status` for chunk counts.

## Current Position
The GC mechanism exists (ADR-017) and is explicit and manual by design. But nothing helps the user decide *when* to trigger it. The only signal today is "chunks count seems high" from `prag status`.

## Proposed Direction (not scheduled)
- Add a `chunks_pool` disk usage estimate to `prag status` / `GET /projects` output.
- Optionally, a configurable `storage.maxChunkPoolBytes` that logs a warning when exceeded.
- Document expected disk usage patterns (one project, many branches) so users know what "normal" looks like.

## Acceptance Criteria (when scheduled)
- `prag status` reports approximate `chunks_pool` + `vector_pool` disk usage.
- A configurable soft limit exists that logs a warning without interrupting ingestion.
- The manual GC path remains the only deletion mechanism; no automatic scheduling is added.
