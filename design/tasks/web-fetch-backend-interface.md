---
class: task
id: web-fetch-backend-interface.md
title: Define the capability-negotiating web fetch backend interface
status: done
priority: medium
relates-to:
  - feature:web-and-nonlocal-content.md
blocks:
  - task:web-ingestion-pipeline.md
  - task:firecrawl-backend.md
  - task:exa-backend.md
tested-by:
  - coretest:web-backend.test.ts
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

## Implementation status 2026-11-03

The interface, the built-in backend and selection are done. Two requirements
belong to the pipeline task and are noted below rather than half-built.

- **Backend interface — DONE.** `core/src/web-backend.ts` exports
  `WebFetchBackend` with `id`, `endpoint`, a `capabilities` set over
  `fetch`/`discover`/`search`, and a `freshnessHint` on every result
  (`live` vs `cached`, with an age when the backend reports one). The hint is
  not cosmetic: ADR-008's leases cannot be set honestly without knowing which
  it was.
- **`plain-fetcher` — DONE.** `fetch` only, standard library, no dependency,
  no third party in the path. It reports its endpoint as "(direct to origin)"
  because that is what it is, and always reports `live` freshness because it
  holds no cache and claiming otherwise would be a lie the leases act on. The
  payload is capped while reading rather than after, so a huge response does
  not cost the memory before being rejected.
- **Exactly one backend, never implicit — DONE.** `resolveWebBackend` returns
  null for no configuration (local-only, the default) and throws at startup
  for an unknown id, naming the valid ids. A typo cannot silently route egress
  somewhere the user did not choose.
- **`PragConfig.web` — DONE.** `backend`, `firecrawl.url`, `firecrawl.apiKey`,
  `exa.apiKey`, read through `loadPragConfig`, with `PRAG_WEB_BACKEND`
  overriding the file.
- **Capability refusal — DONE.** `requireCapability` throws
  `CRAWL_CAPABILITY_UNAVAILABLE` naming the missing capability and which
  registered backends provide it; no backend at all is
  `CRAWL_BACKEND_REQUIRED`. `/projects/watch` on a non-`file://` URI now asks
  for `discover`, not `fetch`: watching a prefix is a crawl, and a fetch-only
  backend must say so rather than quietly indexing the one page.
- **Backend visible in `GET /health` — DONE.** id, endpoint and capabilities,
  or `null`. ADR-024 §2 requires the egress path be inspectable, including
  when it is "none".
- **Stub backend, no egress — DONE.** `coretest:web-backend.test.ts` drives a
  stub for capability negotiation and a loopback server for the fetcher. No
  test makes an outbound call, and the capability error is asserted by `code`
  (ADR-022), never by message text.

### Closed 2026-11-03: the two deferred requirements landed with the pipeline

Both were held back because they belong where content is written, and that
did not exist. It does now (`task:web-ingestion-pipeline.md`, done):

- **Grant re-evaluation of backend-returned URLs — DONE.** `ingestWebUri`
  calls `evaluateUriGrants` on the requested URL, requiring an explicit
  `allow` rather than merely "not denied", and again on the *final* URL after
  redirects -- otherwise an allow on one host is a way to index another.
  `ingestWebSite` routes every discovered URL through the same gate, so a
  `deny` on a child of an allowed prefix wins even when the site's own
  sitemap advertises it. Asserted in `daemontest:web-crawl.test.ts`.
- **`ingestion.maxFileBytes` applied to backend payloads — DONE.** Passed to
  `backend.fetch` as `maxBytes` and applied again to the returned text, so a
  backend that ignores the hint cannot exceed the budget.

`/projects/watch` no longer refuses non-`file://` URIs: with `crawlberg`
configured a page is fetched and a bare origin is crawled. With no backend it
still refuses, with `CRAWL_BACKEND_REQUIRED`, which is the correct answer for
a local-only install.

**This task is complete.** The remaining backends (`task:firecrawl-backend.md`,
`task:exa-backend.md`) implement this interface rather than change it; `exa`
is the only one that would add a capability (`search`).
