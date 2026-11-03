---
class: feature
id: web-and-nonlocal-content.md
title: Non-Local Content and Pluggable Web Fetch Backends
status: accepted
priority: medium
area: ingestion
guided-by:
  - adr:ADR-008.md
  - adr:ADR-024.md
---
## Overview
Support indexing of non-local content such as online library documentation, API
references, and web pages directly via URI, with automated re-fetching driven by
TTL freshness leases (`validUntil`). Fetching is delegated to a **pluggable
backend** — a self-hosted crawler, a hosted extraction service, a search index,
or a plain HTTP fetcher — rather than to one mandated vendor (ADR-024).

This is the only part of prag that is not local-first. It is opt-in per URI,
visible in status output, and never involved in serving a local query.

## Backend Contract
A backend implements a subset of three capabilities and declares which:

| Capability | Meaning |
|---|---|
| `fetch` | Retrieve one granted URL, return Markdown + metadata. |
| `discover` | Enumerate URLs under a granted prefix (site crawl or index query). |
| `search` | Answer a query with URLs + content. Optional; not used by ingestion. |

Built-ins: `crawlberg` (`fetch` + `discover`, HTML->Markdown, the recommended
choice), `firecrawl`, `exa`, and `plain-fetcher` (`fetch` only, zero
dependencies, for an install that wants no native addon).
Configuration selects exactly one ingestion backend via `web.backend`; each backend
takes its own config block. See `resource:env-and-storage-paths.md`.

Requirements:
- **No silent capability degradation.** A glob grant against a backend without
  `discover` fails with `CRAWL_CAPABILITY_UNAVAILABLE`, naming the missing
  capability and which backends provide it. Single-URL registration works on any
  backend with `fetch` (ADR-023: a deliberate limit must be distinguishable from a bug).
- **No automatic fallback.** If the configured backend is unreachable, ingestion
  fails; falling back from a self-hosted instance to a hosted vendor would be an
  unannounced change of egress path.
- **Grants are enforced around the backend, not inside it.** The requested prefix
  bounds what prag asks for; every URL the backend returns is re-evaluated against
  the grants table before it is written, so a `prag deny` holds even when the
  backend surfaced that URL through a sitemap, a link, or its own index.
- Backend output is untrusted input of unknown size: subject to
  `ingestion.maxFileBytes`, never interpreted as instructions.
- **`discover` is asynchronous.** A crawl outlives the request that started it;
  prag tracks the outstanding job per project, can cancel it, and surfaces it in
  `GET /projects`. `POST /sync` awaits it or returns `SYNC_TIMEOUT` naming what is
  still outstanding (ADR-019).

## Grant Evaluation
Web URIs are governed by the same `grants` table as local file URIs (see `project-registry-and-status.md`). When a user runs `prag watch https://docs.lancedb.com/**`, the daemon inserts an `allow` grant with pattern `https://docs.lancedb.com/**`. The same longest-prefix matching and deny-default semantics apply:
- `prag deny https://docs.lancedb.com/private/**` overrides a broader allow.
- Built-in global denials (`**/node_modules/**`, etc.) cover no https paths in practice but are evaluated uniformly.
- Web projects are discovered and tracked in `projects` with `isGit = false` and `status = 'idle'`.

## Storage
- **`branch_mapping`:** Uses the canonical `$default` branch sentinel with `projectId` = the site's normalized base URI (e.g. `https://docs.lancedb.com`). `uri` stores the path portion relative to that root (e.g. `javascript`), so the full URL is `projectId + '/' + uri` -- the same convention as local files.
- **`file_mapping`:** Holds the extracted clean Markdown text of the page.
  - `validUntil = now() + ttl` (default: 1 day, per `defaults.webCooldownSeconds` in `~/.config/prag/config.json`; configurable per source up to multi-day TTLs for slow-changing docs).
  - A backend that returns content sourced from a cache or index of unknown age does **not** get the full lease; prag shortens `validUntil` to reflect that the copy may be stale (ADR-024). Freshness remains prag's clock — backends expose no portable conditional fetch.
  - When `validUntil` is `null`, the page is treated as permanent static documentation (never re-fetched).
- **`chunk_mapping` & `chunks_pool`:** Stores structural markdown chunks and vector embeddings with full deduplication.

## Ingestion Pipeline
- **Backend call:** `fetch` (or `discover` then `fetch` for a glob grant) returns clean Markdown, which enters the same parse/chunk/embed path as a local file.
- **Scheduled Refresh:** A periodic background scheduler checks for web entries where `validUntil IS NOT NULL AND validUntil <= now()`, re-fetching and writing only when `contentHash` changed.
- **Opt-in only:** No web fetch ever occurs for a URI unless the user has explicitly registered it via `prag watch <https-uri>`; this is the sole source of outbound network calls in the system (ADR-024).
- **Backend is reported:** the active backend id and endpoint appear in `prag status` / `GET /health`, so a user can see where their traffic goes without inspecting config.
