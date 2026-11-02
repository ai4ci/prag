---
class: task
id: ingestion-limits-and-admission.md
title: Implement discovery filters, skip reporting and watch admission control
status: in_progress
priority: high
relates-to:
  - feature:project-registry-and-status.md
addressed-by:
  - src:daemon/src/ingestion-queue.ts#IngestionQueue
  - src:daemon/src/ingestion-queue.ts#IngestionConfig
  - src:core/src/discovery.ts#discoveryDryRun
  - src:daemon/src/daemon.ts#_handleWatchUri
  - src:cli/src/main.ts#summarizeSkipped
tested-by:
  - daemontest:ingestion-queue.test.ts#ingestionQueueSuite
  - daemontest:ingestion-e2e.test.ts#daemonWithIngestionSuite
  - daemontest:watch-admission.test.ts#watchAdmissionSuite
  - clitest:e2e.test.ts#cLIEndToEndSuite
---
## Objective
Implement ADR-023 so a single `prag watch ~/Git` cannot silently commit the machine to hours of indexing, and so anything excluded is visibly excluded.

## Requirements
### Discovery filters
- Apply `ingestion.maxFileBytes` (default `2097152`) and NUL-byte binary detection over the first 8KB **at discovery**, before a URI is enqueued. These sit alongside the built-in ignore grants (ADR-009), not in place of them.
- A skipped file is never read a second time and never enters the queue.

### Skip reporting
- Maintain per-project counters by reason (`tooLarge`, `binary`, `denied`), returned by `GET /projects` and rendered by `prag status` as e.g. `1,203 skipped (40 too large, 1,163 binary)`.
- Counters are per-scan and in-memory. They are rebuilt by the next scan and are deliberately **not** added to the `projects` schema.
- This is not optional polish: a user whose file is missing from results cannot otherwise tell a deliberate limit from a bug.

### Admission control
- `prag watch <uri>` performs a discovery dry run first. If it would register more than `ingestion.watchConfirmThreshold` (default 25 projects or 20,000 files), print what would be indexed and require `--yes` to proceed.
- The MCP `watch_uri` tool applies the same threshold but **fails** with `WATCH_LIMIT_EXCEEDED` (ADR-022) instead of prompting — an agent has no terminal to confirm at. The error's `details` carry the counts so the agent can report them to the user.

### Pause/resume
- Implement `prag pause <project>` and `prag resume <project>`, setting and clearing `projects.status = 'paused'`. The status value already exists in the schema and nothing currently sets it.
- A paused project keeps its grants and its indexed data; only scanning and ingestion stop.

### Rate cap
- Bound ingestion throughput using `embedding.batchSize` and `ingestion.workerPoolSize` (ADR-021) so indexing cannot saturate the machine regardless of queue depth.

## Verification
- `prag watch` against a fixture tree exceeding the threshold refuses without `--yes` and indexes nothing.
- `watch_uri` against the same tree returns `WATCH_LIMIT_EXCEEDED` with counts in `details` and registers no grant.
- A file over `maxFileBytes` and a binary file are both absent from search results **and** both appear in `prag status` skip counts with the correct reason.
- `prag pause` stops ingestion within one queue cycle; `prag resume` continues without re-indexing already-current files.

## Implementation status

Reverted from `done`: discovery filters and counters work, but nothing consumes the
counters, and admission control, pause enforcement and the rate cap do not exist.

- **Skip counters are write-only — PARTIAL.** Counted correctly at discovery
  (`packages/daemon/src/ingestion-queue.ts:146-147,159-160` via `_incrementSkip` at
  `:173-176`) and exposed by `getSkipCounters()` (`:121-123`), but the **only** caller is a
  unit test (`packages/daemon/test/ingestion-queue.test.ts:135,199`). No endpoint returns
  them — `GET /projects` omits them (documented as required in
  `design/resources/cli-and-mcp-interface.md`) — and `prag status` prints pid/root/dataDir
  only (`packages/cli/src/main.ts:277-291`). The requirement's stated purpose ("a user whose
  file is missing from results cannot otherwise tell a deliberate limit from a bug") is
  unmet: skips are invisible to the user.
- **Admission control — MISSING.** `watchConfirmThreshold` exists solely as a type field
  (`packages/core/src/paths.ts:104`); grepping it across `packages` finds no reader. No
  discovery dry run exists to count against it (see `task:project-registry-and-exclusions.md`),
  `prag watch` has no `--yes` (`packages/cli/src/main.ts:217-224`), and `WATCH_LIMIT_EXCEEDED`
  has no match anywhere (`grep -rn WATCH_LIMIT packages/` → 0). `watch_uri` is not implemented
  at all (`task:mcp-server-endpoint.md`).
- **Pause is a status write, not a gate — PARTIAL.** `POST /pause` sets
  `projects.status = 'paused'` (`packages/daemon/src/daemon.ts:302,695-723`) and the CLI test
  asserts the row flips (`packages/cli/test/daemon-client.test.ts:134`), but **no code reads
  `paused`**: the watcher keeps firing and `_checkFile`/dispatch consult only
  `_shouldIgnore` and size/binary limits. Ingestion continues at full rate while paused, and
  `resume` is indistinguishable from never having paused.
- **Rate cap — MISSING.** `ingestion.workerPoolSize` (`paths.ts:102`) and
  `embedding.batchSize` (`paths.ts:97`) are read by nothing outside one hardcoded literal —
  `const batchSize = 50` inside `/reembed` (`daemon.ts:671`). `WorkerPool` has no concurrency
  term (grep `concurrency|maxWorkers|semaphore` in `packages/daemon/src/worker-pool.ts` → 0),
  so queue depth alone bounds ingestion, which is what ADR-021 forbids.
- **Denied-reason counter never incremented.** `skipCounters` records `tooLarge` and
  `binary`; `denied` has no increment site, because denial happens nowhere on the ingestion
  path (grants are not consulted — see `task:project-registry-and-exclusions.md`).

Satisfied: `maxFileBytes` (default 2 MiB, `ingestion-queue.ts:57,146`) and NUL-in-first-8KB
binary detection (`:156-160`) applied at discovery, before enqueue, with the file read once;
counters are per-scan, in-memory, and correctly absent from the `projects` schema.
**Skip reporting is now caller-visible** (2026-11-02): `GET /projects` returns each project's
`skipped` map (`daemon.ts` `_handleListProjects`) and both `prag status` and `prag projects`
render it via `summarizeSkipped` (`packages/cli/src/main.ts`) as
`1,203 skipped (40 tooLarge, 1,163 binary)`. `prag status` additionally prints the live
ingestion snapshot (`/health.ingestion`: watched / queued / in flight / cooling). Asserted by
`daemontest:ingestion-e2e.test.ts` (registers a project containing an over-limit file and a
NUL-byte file, then asserts `skipped.tooLarge === 1 && skipped.binary === 1` over HTTP, and that
neither file is searchable) and `clitest:e2e.test.ts` for the formatting.
`empty` is a fourth reason; `denied` increments only on the stat/open failure path and needs the
grants gate below to be meaningful.

Remaining: implement the discovery dry run + threshold + `--yes` and the MCP `WATCH_LIMIT_EXCEEDED` variant; make the ingestion
dispatch check `projects.status = 'paused'`; honour `workerPoolSize`/`batchSize` as the
throughput bound; add the `denied` counter once grants gate admission.

**Admission control, pause and the denied counter are implemented** (2026-11-02, `41f1cd2`):
- **Discovery dry run — DONE.** `discoveryDryRun()` (`packages/core/src/discovery.ts`) walks a
  tree counting files, child git repos and per-reason skips, without reading file bodies past the
  8KB probe. `POST /projects/watch` (`daemon.ts` `_handleWatchUri`) writes the allow grant, runs
  the dry run, and answers `409 WATCH_LIMIT_EXCEEDED` with `{projects, files, threshold}` in
  `details` and **nothing written** when past `ingestion.watchConfirmThreshold` without
  `confirm`. `prag watch` sends `--yes`/`-y` as `confirm` and prints the counts.
- **Grants gate admission — DONE.** `_checkFile` consults the grants table (through a 1s cache,
  invalidated by every grant mutation) *before opening the file*, so a deny on a secret means it
  is never read. Both the watcher and `/sync` route through this one gate, which is why a deny
  cannot be raced by an already-queued event. `denied` is now a real counter, and the dry run
  reports a denied subtree as excluded rather than indexable.
- **`prag deny` now excludes — DONE.** It removes the covered `file_mapping`/`chunk_mapping` rows
  (pool rows stay: they are content-addressed and shared — `--gc-chunks` owns reclamation) and
  un-watches the project whose root lies under the pattern, so the path stops producing events.
- **Pause is a gate — DONE.** Admission reads project status; a paused project's events are
  dropped, and `resume` forces a full re-walk (`IngestionQueue.rescan`) because the incremental
  walk is mtime-based and would consider writes made while paused already seen.
- **Non-local URIs refuse — DONE.** A non-`file://` URI to `/projects/watch` returns
  `503 CRAWL_BACKEND_REQUIRED` (ADR-024) instead of writing a grant that indexes nothing.

Asserted by `daemontest:watch-admission.test.ts` (6 tests: refusal changes nothing, `confirm`
indexes the tree, deny purges + blocks re-indexing and increments `denied`, a denied directory is
excluded at discovery, pause holds a file that resume then indexes, `CRAWL_BACKEND_REQUIRED`).

Remaining: the **rate cap** (honour `ingestion.workerPoolSize`/`embedding.batchSize` as a
throughput bound — `WorkerPool` still has no concurrency term beyond worker count) and the MCP
`watch_uri` tool, which needs `task:mcp-server-endpoint.md` and must reuse
`_handleWatchUri`'s threshold logic rather than reimplement it.
