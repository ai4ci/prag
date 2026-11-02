---
class: task
id: web-fetch-backend-interface.md
title: Define the capability-negotiating web fetch backend interface
status: todo
priority: medium
relates-to:
  - feature:web-and-nonlocal-content.md
blocks:
  - task:web-ingestion-pipeline.md
  - task:firecrawl-backend.md
  - task:exa-backend.md
---
## Objective
Define and ship the `WebFetchBackend` interface from ADR-024, with the three
built-ins and capability reporting, so ingestion code never names a vendor.

## Requirements
- Export the backend interface from `@prag/core`: a `capabilities` set over
  `fetch` / `discover` / `search`, plus `id`, `endpoint`, and a
  `freshnessHint` on each result (whether content came from a live fetch or a copy
  of unknown age, and how old if known).
- Implement `plain-fetcher` (`fetch` only, standard library HTTP, no new
  dependency) as the zero-configuration built-in.
- Select exactly one ingestion backend from `web.backend`; a misconfigured or
  unknown id fails at startup with a named error listing the available backends —
  it never silently falls back (ADR-024).
- Extend `PragConfig` in `packages/core/src/paths.ts` with the `web` block
  (`backend`, `firecrawl.url`, `firecrawl.apiKey`, `exa.apiKey`) — the interface
  currently has no `web` key at all (`packages/core/src/paths.ts:88-117`), and
  `loadPragConfig` is the single place config.json is read.
- Reject a grant that needs a capability the backend lacks with
  `CRAWL_CAPABILITY_UNAVAILABLE`. The error names the missing capability and which
  configured backends provide it, and its `remedy` tells the user to register the
  specific URL or switch backend.
- Re-evaluate every backend-returned URL against the grants table before writing;
  test that an `allow` on a parent prefix plus a `deny` on a child keeps the child
  out even when the backend lists it.
- Apply `ingestion.maxFileBytes` to backend payloads and assert backend text is
  treated as data, never as instructions.
- Add a stub backend to the test harness so backend behaviour is tested without
  egress; no test may perform a network call.

## Verification
- Unit tests drive each built-in and the stub; the capability-missing error is
  asserted by `code`, not message text (ADR-022).
- Running the suite with the network disabled is indistinguishable from a normal run.
