---
class: feature
id: web-and-nonlocal-content.md
title: Non-Local Content and Web URI Ingestion (Firecrawl)
status: accepted
priority: medium
area: ingestion
guided-by:
  - adr:ADR-008.md
  - adr:ADR-012.md
---
## Overview
Support indexing of non-local content such as online library documentation, API references, and web pages directly via URI, with automated re-crawling driven by TTL freshness leases (`validUntil`).

## Architecture & Storage Integration
Web resources integrate natively into the shared URI grants table and the LanceDB CAS schema:

### Grant Evaluation
Web URIs are governed by the same `grants` table as local file URIs (see `project-registry-and-status.md`). When a user runs `prag watch https://docs.lancedb.com/**`, the daemon inserts an `allow` grant with pattern `https://docs.lancedb.com/**`. The same longest-prefix matching and deny-default semantics apply:
- `prag deny https://docs.lancedb.com/private/**` overrides a broader allow.
- Built-in global denials (`**/node_modules/**`, etc.) cover no https paths in practice but are evaluated uniformly.
- Web projects are discovered and tracked in `projects` with `isGit = false` and `status = 'idle'`.

### Storage
- **`branch_mapping`:** Uses the canonical `$default` branch sentinel with `projectId` = the site's normalized base URI (e.g. `https://docs.lancedb.com`). `uri` stores the path portion relative to that root (e.g. `javascript`), so the full URL is `projectId + '/' + uri` -- the same convention as local files.
- **`file_mapping`:** Holds the extracted clean Markdown text of the page.
  - `validUntil = now() + ttl` (default: 1 day, per `defaults.webCooldownSeconds` in `~/.config/prag/config.json`; configurable per source up to multi-day TTLs for slow-changing docs).
  - When `validUntil` is `null`, the page is treated as permanent static documentation (never re-crawled).
- **`chunk_mapping` & `chunks_pool`:** Stores structural markdown chunks and vector embeddings with full deduplication.

## Ingestion Pipeline
- **Crawler:** Integration with Firecrawl (self-hosted instance by default, see ADR-012; the hosted firecrawl.dev API is an optional convenience) or a lightweight headless fetcher to extract clean Markdown from HTML.
- **Scheduled Refresh:** A periodic background scheduler checks for web entries where `validUntil IS NOT NULL AND validUntil <= now()`, fetching updated versions only when content has changed.
- **Opt-in only:** No web fetch ever occurs for a URI unless the user has explicitly registered it via `prag watch <https-uri>`; this is the sole source of outbound network calls in the system (ADR-012).
