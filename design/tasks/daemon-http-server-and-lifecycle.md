---
class: task
id: daemon-http-server-and-lifecycle.md
title: Implement daemon local loopback HTTP server and lifecycle management
status: todo
priority: high
relates-to:
  - feature://background-worker-queue.md
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