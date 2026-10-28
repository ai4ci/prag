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
- Implement endpoint `GET /health` returning status, PID, port, uptime, and loaded models.
- Implement endpoint `POST /search` accepting `SearchQueryOptions`, vectorizing query using hot ONNX session, and querying LanceDB.
- Implement endpoint `GET /projects` and `POST /projects` for workspace management.
- Implement endpoint `POST /shutdown` for clean exit after flushing queues.
- Ensure strict loopback security: reject any non-127.0.0.1 connections.