---
class: task
id: embedding-model-migration.md
title: Implement pinned embedding model detection and prag reembed rebuild
status: in_progress
priority: medium
relates-to:
  - feature:background-worker-queue.md
tested-by:
  - daemontest:daemon.test.ts#daemonSuite
---
## Objective
Implement the pinned-embedding-model detection and explicit rebuild workflow described in ADR-015.

## Requirements
- On first data-directory initialization, write `~/.local/share/prag/lancedb/.embedding-model.json` (`{ model, dim, maxVectorUnitTokens, pinnedAt }`) from the active config.
- On every daemon startup, compare the configured `PRAG_EMBEDDING_MODEL`/dimension against the sidecar. On mismatch, serve **only** `GET /health`, `POST /reembed` and `POST /shutdown` (so `prag daemon stop` still works) and refuse everything else -- including `POST /search` -- with the actionable error from ADR-015. Serving search during a mismatch returns confidently ranked nonsense whenever the two models share a dimension, so read-only fallback is not safe.
- Implement `POST /reembed` (`{ model?: string }` -> `{ requeued: number }`) as a **drop-and-requeue rebuild**, not a vector swap:
  - drop `branch_mapping`, `file_mapping`, `chunk_mapping`, `chunks_pool`, `vector_pool`; keep `grants` and `projects`;
  - write the new sidecar;
  - set `projects.status = 'indexing'` and enqueue a full discovery rescan of every registered project;
  - return immediately once the queue is seeded. The rebuild proceeds in the background on the normal ingestion queue.
- Implement `prag reembed [--model <name>]` CLI command calling the above and returning as soon as the requeue is acknowledged. Progress is observed via `prag status`, not by holding the HTTP request open.
- Do **not** attempt an in-place re-embed. A fixed-width vector column cannot absorb a dimension change, an interrupted run would mix two embedding spaces, and vectorised-unit boundaries are tokenizer-dependent (ADR-014) so they must be recomputed, not reused.
