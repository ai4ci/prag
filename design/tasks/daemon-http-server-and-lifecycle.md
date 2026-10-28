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
- Implement endpoint `GET /health` returning status, `service: "prag-daemon"`, version, PID, port, uptime, and loaded models (ADR-016) -- unauthenticated, but no indexed content or grant data in the response.
- Implement endpoint `POST /search` accepting `SearchQueryOptions`, vectorizing query using hot ONNX session, and querying LanceDB.
- Implement endpoint `GET /projects` and `POST /projects` for workspace management.
- Implement endpoint `POST /shutdown` for clean exit after flushing queues.
- Ensure strict loopback security: reject any non-127.0.0.1 connections.
- Implement bearer-token auth per ADR-013: generate/persist `daemon.token` (0600) on first start, require `Authorization: Bearer <token>` on every endpoint except `GET /health`, reject mismatched `Origin` headers, and add `prag daemon token` / `prag daemon rotate-secret`.