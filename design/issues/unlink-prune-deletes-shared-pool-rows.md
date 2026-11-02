---
class: issue
id: unlink-prune-deletes-shared-pool-rows.md
title: Unlink and prune delete chunks_pool/vector_pool rows without --gc-chunks, destroying content other projects still reference
status: open
priority: high
relates-to:
  - feature:git-branch-awareness.md
blocks:
  - task:branch-mapping-and-pruning.md
---
## Problem
ADR-017 makes chunk garbage collection explicit and opt-in (`prag prune --gc-chunks`
/ MCP `prune_index` with `gcChunks: true`) precisely because `chunks_pool` and
`vector_pool` are **globally deduplicated**: one row can be referenced by
`chunk_mapping` rows belonging to several projects and several branches. Two code
paths delete pool rows without that gate, so removing one file can destroy content
another project still indexes.

Both paths run on an ordinary unlink:

- `Daemon._handleUnlink` — `packages/daemon/src/daemon.ts:199-202`:
  ```ts
  for (const cm of chunkMaps) {
    await this.db.table("chunks_pool").delete(`chunkHash = '${cm.chunkHash}'`);
    await this.db.table("vector_pool").delete(`chunkHash = '${cm.chunkHash}'`);
  }
  ```
- `Daemon._handlePrune` — `packages/daemon/src/daemon.ts:610-611`, the same two
  deletes inside the stale-branch sweep, again with no reference check.

Neither consults whether a *different* `fileVersionId` still points at the hash.
The deletion is unconditional, and neither call is behind `--gc-chunks`.

## Why it is silent
`prag search-local` returns nothing for the affected content in the *other*
project, with no error anywhere: the `chunk_mapping` row survives while its pool
row is gone. Because `chunks_pool` is the source of raw text (ADR-002's local
retention rationale: survive uncommitted edits and branch hopping), the deleted
text cannot be recovered without re-reading the file — and for a branch that is no
longer checked out, the file is not readable at that path at all, so the content is
lost until that branch is re-indexed from a real checkout.

This also defeats the storage premise of ADR-002: content embedded "exactly once"
per hash is not merely a CPU/disk optimisation, it is a correctness invariant, and
deleting one reference invalidates every other reference.

## Expected Behaviour
- Deleting a `chunk_mapping` row must never delete a pool row that any remaining
  `chunk_mapping` row still references.
- Pool-row deletion belongs **only** to the explicit GC sweep, which computes the
  unreferenced set (`chunks_pool` hashes with no `chunk_mapping` reference) and
  deletes exactly that set, then `optimize()`s both tables (ADR-017).
- The GC sweep must still drain and pause ingestion around the sweep, per
  `task:branch-mapping-and-pruning.md` — the read-then-write dedup window is the
  reason that pause exists, and it applies equally here.

## Acceptance Criteria
- Two projects indexing a file with identical normalized content (hence one shared
  `chunkHash`) are both searchable. Deleting the file from project A leaves project
  B's search results byte-identical.
- A stale-branch prune that removes the last reference to a hash leaves the pool row
  in place; the pool row disappears only after `prune --gc-chunks`, and
  `prag status` chunk counts drop accordingly.
- A test asserts the pool row survives unlink, by querying `chunks_pool` directly
  rather than relying on search results.
- `grep -n 'chunks_pool").delete' packages/daemon/src/daemon.ts` matches only inside
  the `gcChunks` branch.

## Related
Contradicts `task:branch-mapping-and-pruning.md` ("Never automatic, never
reference-counted") and `issue:chunk-pool-disk-usage-growth.md`, which assumes the
manual GC path is the only deletion mechanism. Note the tension: ADR-017 forbids
*reference counting* as a policy, but a reference **check** at deletion time is
required by correctness — the fix must avoid counting per row while still refusing
to delete a referenced hash.
