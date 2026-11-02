---
class: task
id: search-project-scoping.md
title: Scope search to a projectId through the daemon and hybridSearch
status: todo
priority: high
relates-to:
  - feature:workspace-isolation.md
blocks:
  - task:workspace-isolation-enforcement.md
  - task:mcp-server-endpoint.md
---
## Objective
Make `projectId` a real query filter. Today `hybridSearch()` takes no project
argument (`packages/core/src/search.ts:53-58`), so **every** search — CLI
`search-local`, `POST /search`, and MCP `search_local` — returns hits from every
indexed project. MCP `search_local` accepts a required `projectId` and echoes it
back into the response payload without filtering on it
(`packages/daemon/src/mcp-server.ts:72-102`), which reads as enforcement to a
caller and provides none.

ADR-018 made `search_local` one-project and `search_all` unscoped; nothing in the
query path implements that distinction. This is the implementation half —
`task:workspace-isolation-enforcement.md` verifies the result and must not be
attempted first, since a test written now can only assert the broken behaviour.

## Requirements
- Add project scoping to `hybridSearch()` so both retrieval arms (BM25 and vector)
  are restricted **before** RRF fusion, not by post-filtering fused results:
  post-filtering would silently shrink `limit` below the requested count whenever
  another project ranked higher.
- Restrict via the scalar index on `chunk_mapping`/`file_mapping` (`projectId`) so
  the filter is a LanceDB predicate evaluated against the column layout (ADR-002's
  pre-filtering rationale), not a JS filter over fetched rows.
- Branch scoping travels with it: a scoped search must also honour the branch
  pointer set, so `search-local` in a git workspace sees the active branch plus
  `$default`, never a sibling branch's rows.
- `POST /search` and MCP `search_local` pass the resolved `projectId` through; MCP
  keeps `projectId` required (ADR-018 — an MCP caller has no cwd, so a missing id is
  `PROJECT_ID_REQUIRED`, never a silent widening).
- `search-all` / `search_all` remains the only unscoped path and stays explicit.
- Dedup must not leak: two projects sharing a normalized `chunkHash` return only the
  scoped project's hits, even though the pool row is shared (the API-layer half of
  `issue:unlink-prune-deletes-shared-pool-rows.md`).
- Report per-project hit counts in the response so a caller can see scoping happened
  rather than trusting it.

## Verification
- Index two projects with one byte-identical file; `search_local` with `projectId: A`
  returns zero hits from B. Assert on the returned `projectId` of every hit, not on
  result counts alone.
- A query whose top hits live entirely outside the requested project still returns a
  full `limit` of in-scope hits — this is the test that catches post-filter fusion.
- With the same content on two branches, only the active branch and `$default` appear.
- `search-all` returns hits from both projects, proving the filter is scoped rather
  than globally narrowed.
