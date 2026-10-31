---
class: task
id: web-ingestion-pipeline.md
title: Implement Firecrawl-backed web ingestion with self-hosted endpoint support
status: todo
priority: medium
relates-to:
  - feature:web-and-nonlocal-content.md
---
## Objective
Implement the web/non-local content ingestion pipeline described in `web-and-nonlocal-content.md`, consistent with the self-hosted-by-default scope in ADR-012.

## Requirements
- Integrate a Firecrawl client configurable against a self-hosted instance (`PRAG_FIRECRAWL_URL`) as well as the hosted API; support a plain headless-fetcher fallback when neither is configured.
- Convert fetched HTML to clean Markdown prior to chunking.
- Store results using `projectId` = the granted site's normalized base URI (e.g. `https://docs.lancedb.com`) and `branch = '$default'` per the CAS schema.
- Set `validUntil = now() + webCooldownSeconds` (default from `defaults.webCooldownSeconds` in config.json); support `validUntil = null` for permanent static docs.
- Implement the scheduled refresh scan: `validUntil IS NOT NULL AND validUntil <= now()`, re-fetching only changed content.
- Enforce opt-in only: no fetch occurs for a URI without a matching `allow` grant (reuse the grants evaluation engine from `project-registry-and-exclusions.md`).