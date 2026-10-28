---
class: task
id: embedding-model-migration.md
title: Implement pinned embedding model detection and prag reembed migration
status: todo
priority: medium
relates-to:
  - feature://background-worker-queue.md
---
## Objective
Implement the pinned-embedding-model detection and explicit migration workflow described in ADR-015.

## Requirements
- On first data-directory initialization, write `~/.local/share/prag/lancedb/.embedding-model.json` (`{ model, dim, pinnedAt }`) from the active config.
- On every daemon startup, compare the configured `PRAG_EMBEDDING_MODEL`/dimension against the sidecar; refuse `chunks_pool` writes (keep `/search` read-only available) and exit with an actionable error on mismatch.
- Implement `POST /reembed` (`{ model?: string }` -> `{ reembedded: number }`): batches through every `chunks_pool.text` row, re-embeds with the (new) model, marks affected `projects.status = 'indexing'` during the run, and atomically updates the sidecar only on full success.
- Implement `prag reembed [--model <name>]` CLI command calling the above.
- Do not touch `chunkHash` values or trigger re-parsing/re-chunking -- this only recomputes `chunks_pool.vector`.