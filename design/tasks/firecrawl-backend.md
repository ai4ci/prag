---
class: task
id: firecrawl-backend.md
title: Implement the Firecrawl web fetch backend
status: blocked
priority: low
relates-to:
  - feature:web-and-nonlocal-content.md
blocks:
  - task:web-ingestion-pipeline.md
---
## Objective
Ship the `firecrawl` built-in backend, working against a self-hosted instance by
default and the hosted API as an option.

## Requirements
- Configure via `web.firecrawl.url` / `PRAG_FIRECRAWL_URL`; unset url means the
  hosted API and requires an explicit key, so a misconfiguration cannot quietly
  relocate egress to a third party (ADR-024).
- Declare `fetch` and `discover`; map Firecrawl crawl to `discover`, reporting the
  outstanding job so `POST /sync` can await it or return `SYNC_TIMEOUT` (ADR-019).
- Report `freshnessHint` as live: Firecrawl fetches on request.
- Send the requested prefix as the crawl bound; do not rely on the service to
  honour it — prag re-checks every returned URL against the grants table.
- Surface backend-side rate limits and partial crawls as named errors with the
  number of URLs already ingested in `details`, so a caller can retry without
  re-doing completed work.

## Parked 2026-11-03

Same position as `task:exa-backend.md`: the backend interface exists and
`PragConfig.web.firecrawl.{url,apiKey}` is read, but this needs a credential
(or a self-hosted Firecrawl endpoint) and a decision about test strategy.

`test/fixtures/web/firecrawl-stub.json` already exists, which suggests
recorded fixtures were the intent. Confirming that, and whether a self-hosted
instance is in scope, unblocks it.
