---
class: task
id: ingestion-limits-and-admission.md
title: Implement discovery filters, skip reporting and watch admission control
status: done
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
  - daemontest:config.test.ts#loadConfigSuite
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

Re-audited 2026-11-02 and returned to `done`.

- **Skip counters — DONE.** Exposed per project through the status surface
  (`daemon/src/daemon.ts:913`), so a user whose file is missing from results can
  tell a deliberate limit from a bug. The `denied` reason is incremented
  (`ingestion-queue.ts:314`) alongside `tooLarge`/`empty`/`binary`.
- **Admission control — DONE.** `watchConfirmThreshold` is read at watch time
  (`daemon.ts:1071`) and covered by `daemon/test/watch-admission.test.ts`.
- **Pause — DONE.** Admission consults project status; a paused project's
  events are dropped rather than merely recorded.
- **Discovery dry run, grants gate, `prag deny` exclusion, non-local refusal,
  rate cap — DONE** (unchanged from the previous audit).
