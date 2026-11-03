---
class: task
id: exa-backend.md
title: Implement the Exa web fetch backend
status: blocked
priority: low
relates-to:
  - feature:web-and-nonlocal-content.md
---
## Objective
Ship the `exa` built-in backend: a search-index provider, which has no site-crawl
notion and returns content from a copy of unknown age — the case that forced the
capability model in ADR-024.

## Requirements
- Configure via `web.exa.apiKey` / `PRAG_EXA_API_KEY`.
- Declare `fetch` and `search`; **not** `discover`. A glob grant therefore fails
  with `CRAWL_CAPABILITY_UNAVAILABLE` whose remedy suggests registering the
  specific URLs or selecting a crawling backend — it must not quietly index one page.
- Report `freshnessHint` as cached, with the backend's stated cache age when it
  gives one; prag shortens `validUntil` instead of granting the full
  `defaults.webCooldownSeconds` (ADR-024).
- Use the backend cache-age parameter as a best-effort freshness control only;
  freshness remains prag's lease, never the service's index state.

## Parked 2026-11-03

The interface this builds on now exists (`task:web-fetch-backend-interface.md`:
`WebFetchBackend`, `registerWebBackend`, capability negotiation, and
`PragConfig.web.exa.apiKey` is read). What is missing is a credential and a
decision.

**Questions for the maintainer:** is there an Exa account to develop against,
and should the backend be tested against a recorded fixture rather than the
live API? ADR-024 and `task:web-fetch-backend-interface.md` both require that
no test performs a network call, so a live-API test is not an option -- it
needs either a recorded response fixture or a stub, and which one is a choice
about how much of the real contract to pin down.

`test/fixtures/web/firecrawl-stub.json` exists and suggests the fixture
approach was already intended.
