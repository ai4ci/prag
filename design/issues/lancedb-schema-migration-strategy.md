---
class: issue
id: lancedb-schema-migration-strategy.md
title: LanceDB schema evolution relies on drop-and-reindex
status: open
priority: medium
relates-to:
  - feature://git-branch-awareness.md
---
## Problem
Three kinds of version skew are covered: the HTTP/MCP contract by `apiVersion` (ADR-016), the embedding model by the `.embedding-model.json` sidecar (ADR-015), and the daemon/CLI pairing by the identity check. Nothing covers the **LanceDB table schemas themselves**.

Opening a data directory written by an older `prag` whose `chunk_mapping` lacked a column, or whose `chunks_pool` still carried the vector column it had before ADR-014 split out `vector_pool`, has no defined behaviour. It will either throw an opaque Arrow error or, worse, read successfully and misinterpret the data.

## Current Position (accepted for now)
Drop and re-index. The mechanism already exists: `POST /reembed` drops every content-derived table, keeps `grants` and `projects`, and requeues a full rescan (ADR-015). Everything indexed is local content re-readable from disk, so nothing is unrecoverable — the cost is the rebuild, not data loss.

This is deliberate and adequate pre-1.0. It is recorded here because it is a *decision*, not an oversight, and because it stops being adequate the moment a rebuild is expensive enough that users avoid upgrading.

## What Is Missing
- A `schemaVersion` written alongside the data (the ADR-015 sidecar is the obvious home) so a mismatch **fails loudly** rather than producing an Arrow error or a silent misread. This is the part worth doing before 1.0, independently of any migration machinery.
- A documented upgrade path in the release notes whenever `schemaVersion` changes, telling the user a rebuild will happen.
- Eventually: additive migrations for the common case of adding a nullable column, so a rebuild is reserved for genuinely breaking changes.

## Acceptance Criteria (when scheduled)
- Opening a data directory with an unrecognised `schemaVersion` fails with an actionable message naming the version found, the version expected, and the command to rebuild.
- Adding a nullable column does not require a full re-index.
- A rebuild triggered by a schema change reuses the existing `/reembed` requeue path rather than introducing a second rebuild mechanism.
