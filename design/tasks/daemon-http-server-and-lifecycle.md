---
class: task
id: daemon-http-server-and-lifecycle.md
title: Implement daemon local loopback HTTP server and lifecycle management
status: in_progress
priority: high
relates-to:
  - feature:background-worker-queue.md
addressed-by:
  - src:daemon/src/daemon.ts#Daemon
  - src:daemon/src/daemon.ts#DaemonConfig
  - src:daemon/src/daemon.ts#loadConfig
  - src:daemon/src/daemon.ts#readBody
tested-by:
  - daemontest:daemon.test.ts#daemonSuite
  - daemontest:ingestion-e2e.test.ts#daemonWithIngestionSuite
---
## Description
Implement the HTTP server inside @prag/daemon binding strictly to loopback 127.0.0.1.

## Requirements
- Read port from `~/.config/prag/config.json` (default 7724).
- Implement endpoint `GET /health` returning status, `service: "prag-daemon"`, `apiVersion` (contract version, the only field the CLI compares), `version` (package semver, diagnostics only), PID, port, uptime, and loaded models (ADR-016) -- unauthenticated, but no indexed content or grant data in the response.
- Implement endpoint `POST /search` accepting `SearchQueryOptions`, vectorizing query using hot ONNX session, and querying LanceDB.
- Implement endpoint `GET /projects` and `POST /projects` for workspace management.
- Implement endpoint `POST /shutdown` for clean exit after flushing queues.
- Ensure strict loopback security: reject any non-127.0.0.1 connections.
- Implement bearer-token auth per ADR-013: authenticate against `PRAG_API_KEY` (default `"guest"`), write legacy `~/.local/state/prag/daemon.token` (0600) for backward compat, require `Authorization: Bearer <token>` on every endpoint except `GET /health`, and add `prag daemon token` / `prag daemon rotate-secret` CLI commands.
- Reject any request carrying an `Origin` header that is not a `127.0.0.1`/`localhost` origin, including `Origin: null` -- sandboxed iframes and `data:` documents send exactly that, so it must not be on the allow list (ADR-013).
- Enforce the ADR-015 mismatch gate: when the configured embedding model does not match the sidecar, serve only `GET /health`, `POST /reembed` and `POST /shutdown`.

## Implementation status

Reverted from `done`: routing, loopback binding, Origin rejection and the bearer check are real;
the daemon cannot be started, shutdown truncates itself, and two requirements have no code at all.

- **No wired entry point — MISSING (blocks everything).** `loadConfig()`
  (`packages/daemon/src/daemon.ts:51-59`) has zero call sites (only the re-export at
  `packages/daemon/src/index.ts:1`), and `daemon.ts` has no main guard. Full details and a
  reproduction in `issue:daemon-entry-point-has-no-main.md`.
- **`POST /shutdown` does not flush — PARTIAL.** `daemon.ts:725-733` calls
  `this.stop().catch(() => {})` **without awaiting** and `process.exit(0)` in the same
  `setImmediate` tick, so the close sequence is truncated; and `IngestionQueue.close()`
  (`packages/daemon/src/ingestion-queue.ts:100-119`) clears the dirty set and timers without
  dispatching, so "clean exit after flushing queues" is doubly unmet.
- **ADR-015 mismatch gate — MISSING.** `grep "ADR-015|mismatch|modelMismatch" packages/` (non-dist)
  matches only the sidecar-type comment at `packages/core/src/embedding.ts:34`. The router
  (`daemon.ts:245-318`) has no gate, so `/search`, `/projects` and `/grants` all stay live against a
  mismatched embedding space — mixing two vector spaces silently. Owned jointly with
  `task:embedding-model-migration.md`.
- **`/health` incomplete — PARTIAL** (`daemon.ts:321-335`): no **loaded models** field (ADR-016);
  `version` is the literal `"0.1.0"` (`:328`) not package semver; `port` reports
  `this.config.port` (`:331`) rather than `_boundPort`, so a `PRAG_PORT=0` daemon reports 0; and
  `apiVersion` duplicates a local const (`:36`) instead of importing `API_VERSION`
  (`packages/core/src/database.ts:28`) — the one field the CLI is allowed to compare.
- **`POST /search` ignores scoping — PARTIAL.** Body is typed `Record<string, unknown>`
  (`daemon.ts:340`) and only `query`/`limit` are read (`:348-349`); `projectId` and `branch` from
  `SearchQueryOptions` (`packages/core/src/schema.ts:77-82`) are dropped. Also no ONNX session in
  the package — the embedder is injected, so "hot ONNX vectorization" is only ever exercised with
  the fake provider.
- **`daemon.token` never written — PARTIAL.** The check (`daemon.ts:266-273`) and CLI subcommands
  (`packages/cli/src/main.ts:127-141`, 0600 write at `:138`) exist, but the daemon neither writes
  nor reads the file (`this.token = config.token ?? "guest"`, `:57`) while the client reads it
  (`packages/cli/src/daemon-client.ts:95-110`). Net effect: `prag daemon rotate-secret` then restart
  leaves the daemon on `"guest"` and the client presenting the new token → 401. `OPTIONS` is
  auth-exempt and falls through to 405 (`:317`).
- **Lifecycle robustness — MISSING.** No `server.on("error")`, so `EADDRINUSE` is an uncaught throw;
  no explicit `requestTimeout`/`keepAliveTimeout`/idle handling (`grep` → 0). `/prune` and `/reembed`
  swallow every error and answer HTTP 200 with zeroed counters (`daemon.ts:641-643`, `:690-692`),
  which `task:error-contract.md` must fix.

Satisfied: port default 7724 with config read (`:35,51-59` — correct, just uncalled); strict
loopback bind (`:111`) plus socket-address check for `127.0.0.1`/`::1`/`::ffff:127.0.0.1`
(`:252-256`); Origin regex `^https?://(127\.0\.0\.1|localhost)(:\d+)?$` rejects `Origin: null` as
ADR-013 requires (`:258-263`, untested for the `null` case); bearer token required on everything
except `/health` (`:266-273`); `GET`/`POST /projects` (`:287,296,383-403,405-464`).

Remaining: add the entry point; await `stop()` and flush before exit; implement the ADR-015 gate;
complete `/health` (loaded models, real version, bound port, shared `API_VERSION`); read the full
`SearchQueryOptions`; write and read `daemon.token`; handle `EADDRINUSE` and timeouts.