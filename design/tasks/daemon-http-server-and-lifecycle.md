---
class: task
id: daemon-http-server-and-lifecycle.md
title: Implement daemon local loopback HTTP server and lifecycle management
status: done
priority: high
relates-to:
  - feature:background-worker-queue.md
addressed-by:
  - src:daemon/src/daemon.ts#Daemon
  - src:daemon/src/daemon.ts#DaemonConfig
  - src:daemon/src/main.ts#loadConfig
  - src:daemon/src/daemon.ts#readBody
tested-by:
  - daemontest:daemon.test.ts#daemonSuite
  - daemontest:ingestion-e2e.test.ts#daemonWithIngestionSuite
  - daemontest:config.test.ts#loadConfigSuite
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

Re-audited 2026-11-02 and returned to `done`.

- **Entry point — DONE.** `packages/cli/bin/prag.mjs` is the wired executable;
  `issue:daemon-entry-point-has-no-main.md` is resolved. CI exercises the
  documented commands end to end.
- **`POST /shutdown` flushes — DONE.** `stop()` is awaited before exit
  (`daemon.ts:1907-1912`), and `IngestionQueue.close()` awaits its closers
  (`ingestion-queue.ts:227`) rather than discarding pending work.
- **ADR-015 mismatch gate — DONE.** A mismatched index serves only `/health`,
  `/reembed` and `/shutdown` (`daemon.ts:692`, `MISMATCH_ALLOWED`), and
  `/reembed` now actually escapes that state — see
  `task:embedding-model-migration.md`.
- **`/health` — DONE.** Reports `service`, `apiVersion`, `version`, pid, bound
  port, uptime and the loaded embedding model and dimension (ADR-016).
- **`POST /search` scoping — DONE.** Reads `projectId`, `branch`, `mode` and
  `limit` (`daemon.ts:832-839`).
- **`daemon.port` / `daemon.token` — DONE.** Both written by
  `writeRuntimeFiles()` (`daemon/src/main.ts:264-275`); the token file is 0600.
