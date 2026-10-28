---
class: feature
id: web-and-nonlocal-content.md
title: Non-Local Content and Web URI Ingestion (Firecrawl)
status: accepted
priority: medium
area: ingestion
guided-by:
  - adr://ADR-008.md
---
## Overview
Support indexing of non-local content such as online library documentation, API references, and web pages directly via URI, with automated re-crawling driven by TTL freshness leases (`validUntil`).

## Architecture & Storage Integration
Web resources integrate natively into the 4-table LanceDB CAS schema:
- **`branch_mapping`:** Uses the canonical `$default` branch sentinel with `projectId = 'web'` (or designated custom project slug). `uri` stores the canonical web URL (e.g. `https://docs.lancedb.com/javascript`).
- **`file_mapping`:** Holds the extracted clean Markdown text of the page.
  - `validUntil = now() + ttl` (e.g. 7 days, configurable per source).
  - When `validUntil` is `null`, the page is treated as permanent static documentation (never re-crawled).
- **`chunk_mapping` & `chunks_pool`:** Stores structural markdown chunks and vector embeddings with full deduplication.

## Ingestion Pipeline
- **Crawler:** Integration with Firecrawl or lightweight headless fetcher to extract clean Markdown from HTML.
- **Scheduled Refresh:** A periodic background scheduler checks for web entries where `validUntil IS NOT NULL AND validUntil <= now()`, fetching updated versions only when content has changed.
