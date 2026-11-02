---
class: task
id: web-ingestion-pipeline.md
title: Implement the web URI ingestion pipeline on top of a fetch backend
status: todo
priority: medium
relates-to:
  - feature:web-and-nonlocal-content.md
---
## Objective
Implement the web/non-local content ingestion pipeline described in `web-and-nonlocal-content.md`, calling the `WebFetchBackend` interface rather than any vendor client directly (ADR-024).

## Requirements
- Consume the configured backend through its declared capabilities; contain no vendor names, URLs, or response shapes (those live in `firecrawl-backend.md` / `exa-backend.md`).
- Convert fetched HTML to clean Markdown prior to chunking.
- Store results using `projectId` = the granted site's normalized base URI (e.g. `https://docs.lancedb.com`) and `branch = '$default'` per the CAS schema.
- Set `validUntil = now() + webCooldownSeconds` (default from `defaults.webCooldownSeconds` in config.json); support `validUntil = null` for permanent static docs.
- Implement the scheduled refresh scan: `validUntil IS NOT NULL AND validUntil <= now()`, re-fetching only changed content (compare `contentHash`, write only on change).
- Shorten the granted lease when the backend reports cached content (ADR-024); full `webCooldownSeconds` only for a live fetch.
- Enforce opt-in only: no fetch occurs for a URI without a matching `allow` grant (reuse the grants evaluation engine from `project-registry-and-exclusions.md`).