---
class: task
id: web-ingestion-pipeline.md
title: Implement the web URI ingestion pipeline on top of a fetch backend
status: in_progress
priority: medium
relates-to:
  - feature:web-and-nonlocal-content.md
tested-by:
  - daemontest:web-ingestion.test.ts
  - daemontest:web-crawl.test.ts
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

## Implementation status 2026-11-03

The fetch path is complete end to end. Crawl is not, and no built-in backend
can crawl yet, so it is refused by name rather than half-built.

- **Vendor-agnostic — DONE.** `ingestWebUri` consumes the backend only through
  `WebFetchBackend`; no vendor name, URL or response shape appears outside
  `firecrawl-backend.md` / `exa-backend.md`.
- **`projectId` = the site, `branch` = `$default` — DONE.**
  `Daemon.webProjectId` is scheme + host, so every page of a site is one
  project and a search can be scoped to "the docs" rather than to one page.
  The site is registered in `projects`, without which a scoped search has
  nothing to resolve against.
- **ADR-008 lease — DONE.** `validUntil = now + defaults.webCooldownSeconds`,
  and `0` means permanent: `validUntil` stays null and the scan never revisits
  it.
- **Shorter lease for cached content — DONE.** A cached copy gets the
  *remaining* life (`cooldown - ageSeconds`, floored at a minute), because it
  was already that old on arrival and a full window would make the index
  staler than policy allows. The floor matters: a lease expired on arrival
  would have the scan re-fetch it forever.
- **Scheduled refresh — DONE.** `refreshExpiredWebContent` selects
  `validUntil <= now` and re-fetches; `_ingestFile` compares content hashes,
  so an unchanged page costs one fetch and a lease refresh, not a re-embed. A
  sweep runs on an unref'd interval when a backend is configured, and one
  unreachable page does not stop it.
- **Opt-in only — DONE.** The grants table is consulted at fetch time, not
  merely when the URL was registered, and requires an explicit `allow`
  (deny-by-default, ADR-009). The URL actually retrieved is re-checked after
  redirects, or an allow on one host becomes a way to index another.
- **`maxFileBytes` applied to payloads — DONE**, passed to the backend and
  enforced again on the returned text.
- **Backend text is data — DONE.** It is hashed, chunked and embedded exactly
  like file content, and never interpreted.

### Decisions taken, worth a second opinion

- **Fetch vs crawl is decided from the URL**: a bare origin
  (`https://docs.example.com`) means the site and needs `discover`; anything
  with a path means one document and needs `fetch`. A URL does not say which
  the user meant, so this had to be *some* rule; this one is at least
  predictable without consulting config. Granting a bare origin currently
  succeeds and then reports `CRAWL_CAPABILITY_UNAVAILABLE`, because no
  built-in backend can crawl.
- **HTML becomes text, not Markdown.** The requirement asks for "clean
  Markdown prior to chunking". `plain-fetcher` produces prose, and the pseudo
  path handed to the router ends in `.md` so the heading chunker is used. A
  real HTML-to-Markdown conversion would preserve heading structure and chunk
  better, but it needs a dependency, and Firecrawl returns Markdown natively,
  so the cost falls only on the zero-dependency built-in. Worth revisiting if
  `plain-fetcher` becomes the common path.

### Not done

- **Crawl / `discover` ingestion.** Needs a backend with the capability, which
  is `task:firecrawl-backend.md` / `task:exa-backend.md`, both parked on
  credentials.

## Update 2026-11-03: crawlberg resolves two of the three parked points

`@xberg-io/crawlberg` is registered as a built-in backend (ADR-024 addendum,
`src:daemon/src/crawlberg-backend.ts`).

- **"HTML becomes text, not Markdown" is resolved.** crawlberg emits real
  Markdown -- headings, lists, tables, emphasis -- with page chrome stripped,
  so the `page.md` pseudo path now routes to the heading chunker for a
  document that genuinely has headings, rather than as a trick to get prose
  into a Markdown splitter. Asserted in
  `daemontest:crawlberg-backend.test.ts`.
- **A bare origin no longer dead-ends.** crawlberg declares `discover`, so
  registering a site resolves rather than reporting
  `CRAWL_CAPABILITY_UNAVAILABLE` with no backend able to satisfy it.
  `discover` returns the site's URLs; **ingesting them is still not done** --
  the fan-out from a URL list to per-page `ingestWebUri` calls, bounded by
  ADR-023's concurrency cap, remains unwritten. That is the real remaining
  work here, and it is no longer blocked on credentials.
- **Fetch vs crawl decided from the URL still stands as a guess.** Unchanged
  and still worth a second opinion: a bare origin means the site, a path means
  one document. Now that `discover` has a provider the rule is actually
  reachable, so getting it wrong has consequences it did not have before.

### Crawl ingestion — done

`Daemon.ingestWebSite` closes the remaining half. `discover` names the URLs
and each goes through `ingestWebUri`, which **re-evaluates the grants**: a
backend may return URLs the user never named, and a `deny` on a child of an
allowed prefix has to win (ADR-009). `daemontest:web-crawl.test.ts` denies a
page listed in the site's own sitemap and asserts it stays out of the index.

Three decisions worth stating:

- **Serial, not parallel.** Embedding is on the main thread by ADR-021, so
  parallel fetches would queue behind it and buy nothing, while N connections
  to one host is the behaviour crawlberg's `rateLimitMs` exists to prevent.
  The bound that matters is pages, not concurrency.
- **Bounded by `web.maxPagesPerSite`, default 200.** `discover` reports what a
  site advertises; a 50k-URL sitemap would otherwise make one `prag watch`
  into 50k fetches and embeds.
- **A failing page is counted, not fatal.** One 500 must not abandon a crawl,
  so failures are logged with their URI and reported as `errored` alongside
  the `denied` count, in the same `skipped` shape a local directory scan uses.
  A crawl that indexes nothing is not an error: the grant is written and the
  ADR-008 refresh sweep retries.

`watchUri` on a bare origin now crawls instead of writing the grant and
throwing `CRAWL_CAPABILITY_UNAVAILABLE`.
