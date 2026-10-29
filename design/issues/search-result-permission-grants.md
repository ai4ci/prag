---
class: issue
id: search-result-permission-grants.md
title: Per-caller permission grants for search results
status: open
priority: low
relates-to:
  - feature://dual-interfaces.md
---
## Problem
ADR-018 splits search into `search_local` (one project) and `search_all` (every project). That split is a usability and clarity boundary, and it was initially described as also giving a seam for restricting a caller's reach — "expose only `search_local` to an untrusted agent."

It does not. `search_local` takes a caller-supplied `projectId`, and `get_indexing_status` / `prag projects` enumerate the registered projects. A caller restricted to `search_local` can therefore walk the list and read every indexed project one call at a time. Hiding `search_all` restricts nothing.

Tool selection is simply the wrong level at which to enforce this. The question "which indexed content may this caller see?" is a property of the caller, not of which of two tools it happened to call.

## Proposed Direction (not scheduled)
A `search_grant` concept, parallel to the existing URI `grants` table (ADR-009) but governing *query results* rather than *ingestion*:
- Binds a caller identity (bearer token or MCP connection, per ADR-013) to the set of `projectId`s whose results it may receive.
- Enforced server-side inside the daemon's `SearchEngine`, after candidate retrieval and before results are returned, so it cannot be bypassed by any choice of tool, `projectId` argument, or branch filter.
- Absent a grant, the current behaviour stands: the single local user may read everything they have chosen to index.

## Why Deferred
Everything `prag` indexes today is local content belonging to the single workstation user, reached over a loopback port already protected by a bearer token (ADR-013). There is no second principal to protect content from. This becomes real only with a concrete multi-tenant or shared/remote-daemon use case — at which point the enforcement point above, not the tool split, is where the work goes.

## Acceptance Criteria (when scheduled)
- A restricted caller receives no hits from a non-granted project regardless of which search tool it calls or what `projectId` it supplies.
- Enforcement lives in the daemon's search path, not in MCP tool registration or CLI argument handling.
- Unrestricted single-user operation is unchanged and requires no configuration.
