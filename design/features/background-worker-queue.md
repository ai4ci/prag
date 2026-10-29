---
class: feature
id: background-worker-queue.md
title: Non-Blocking Background Worker Ingestion Queue
status: accepted
priority: high
area: daemon
guided-by:
  - adr://ADR-005.md
  - adr://ADR-008.md
  - adr://ADR-013.md
  - adr://ADR-015.md
  - adr://ADR-016.md
---
## Overview
File-system changes (file mutations, additions, or deletions) must be captured asynchronously, pushed into a thread-safe processing structure, and debounced with cooldown leases to ensure eventual consistency without CPU/GPU thrashing during active editing. The daemon serves as the central manager for all LanceDB operations, ONNX embedding generation, and directory monitoring.

## Local Port & HTTP Lifecycle Endpoints
The daemon binds to `127.0.0.1:<port>` (default `7724`, configured in `~/.config/prag/config.json`) and exposes the following loopback endpoints. All endpoints except `GET /health` require `Authorization: Bearer <token>` per ADR-013.
- `GET /health`: Returns `{ status: "ok", service: "prag-daemon", apiVersion: number, pid: number, version: string, uptime: number, port: number }`. The `service` marker and `apiVersion` are mandatory -- the CLI rejects any listener lacking them rather than falling back to another port (ADR-016).
- `POST /search`: Accepts `SearchQueryOptions`, computes query embeddings using the hot in-memory model, queries LanceDB, and returns `SearchHitResult[]`.
- `GET /projects`: Lists registered workspace directories and their indexing status.
- `POST /projects`: Registers a new project workspace directory for active monitoring.
- `POST /sync`: **Drain barrier** -- triggers branch reconciliation and an immediate flush of debounced ingestion queues, and returns only once the queue is empty, outstanding `validUntil` leases have been forced, and all writes are committed (ADR-019). This is the primitive callers use instead of sleeping before a search.
- `POST /shutdown`: Gracefully flushes active ingestion batches, closes LanceDB tables, and exits.

## Eventual Consistency & Cooldown Leases (`validUntil`)
To prevent GPU/CPU saturation when developers rapidly edit files:
1. When a file is indexed, the daemon sets `validUntil = now() + cooldownSeconds` in `file_mapping` (default: 60s, per `defaults.localCooldownSeconds` in `~/.config/prag/config.json`).
2. Subsequent `change` events while `now() < validUntil` add the URI to an in-memory *dirty set* without triggering immediate AST parsing or neural vector generation.
3. When the cooldown expires, the worker flushes the single latest state of the dirty file to LanceDB.
4. Immediate manual synchronization is available on demand via `POST /sync` or `prag sync`, which forces the flush regardless of any outstanding lease and does not return until it has settled.

## Requirements & Interfaces
The background daemon exposes the following internal control contracts:

```typescript
export interface IngestionQueueItem {
  projectId: string;
  uri: string;
  eventType: 'add' | 'change' | 'unlink';
}

export interface IBackgroundIndexerDaemon {
  /**
   * Initializes persistent database connection layers and primes model execution parameters.
   * Starts local loopback HTTP server on configured port.
   */
  initialize(modelName: string, options: { preferGPU: boolean; port: number }): Promise<void>;

  /**
   * Dynamically attaches a project folder workspace to filesystem monitoring loops.
   */
  registerProject(config: ProjectWorkspaceConfig): Promise<void>;

  /**
   * Schedules a file modification event to process through the thread-safe background queue.
   */
  enqueueFileEvent(item: IngestionQueueItem): void;

  /**
   * Gracefully shuts down HTTP listener and database connections.
   */
  stop(): Promise<void>;
}
```
