// @prag/daemon — Thread-safe worker pool for file ingestion
//
// Spawns a pool of worker_threads that handle file reading and structural
// chunking (Tree-sitter). The main thread receives chunk records,
// embeds them via the hot in-memory model, and writes to LanceDB.
//
// Workers never touch the database or the embedding model — ADR-021 split.

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { type WorkerInput, type WorkerOutput } from "./ingestion-worker.js";

// ── Types ─────────────────────────────────────────────────────────────

export interface ChunkRecord {
  projectId: string;
  filePath: string;
  chunkHash: string;
  text: string;
  startLine: number;
  endLine: number;
  scopeContext: string;
}

export interface ProcessResult {
  projectId: string;
  filePath: string;
  language: string;
  chunks: ChunkRecord[];
  error?: string;
}

type ResolveFn = (r: ProcessResult) => void;
type RejectFn = (e: Error) => void;

// ── WorkerPool ────────────────────────────────────────────────────────

export class WorkerPool {
  private workers: Worker[] = [];
  private pending: Map<number, { resolve: ResolveFn; reject: RejectFn }> =
    new Map();
  private queue: Array<{
    input: WorkerInput;
    resolve: ResolveFn;
    reject: RejectFn;
  }> = [];
  private idle: number[] = [];
  private nextId = 0;

  constructor(
    size: number,
    workerScript?: string,
  ) {
    const script =
      workerScript ??
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "ingestion-worker.ts",
      );

    for (let i = 0; i < size; i++) {
      this._spawn(script);
    }
  }

  /** Submit a file for processing. Returns when a worker finishes. */
  processFile(projectId: string, filePath: string): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const input: WorkerInput = { projectId, filePath };
      const item = { input, resolve, reject };

      if (this.idle.length > 0) {
        this._dispatch(this.idle.pop()!, item);
      } else {
        this.queue.push(item);
      }
    });
  }

  /** Terminate all workers. */
  async close(): Promise<void> {
    await Promise.allSettled(
      this.workers.map((w) => w.terminate()),
    );
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.pending.clear();
  }

  get totalWorkers(): number {
    return this.workers.length;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  // ── Internal ──────────────────────────────────────────────────────

  private _dispatch(idx: number, item: {
    input: WorkerInput;
    resolve: ResolveFn;
    reject: RejectFn;
  }): void {
    this.pending.set(idx, {
      resolve: item.resolve,
      reject: item.reject,
    });
    this.workers[idx].postMessage(item.input);
  }

  private _spawn(script: string): void {
    const idx = this.nextId++;
    const worker = new Worker(script, {
      workerData: { id: idx },
    });

    worker.on("message", (output: WorkerOutput) => {
      // Resolve the pending promise for this worker
      const pending = this.pending.get(idx);
      if (pending) {
        this.pending.delete(idx);
        const result: ProcessResult = {
          projectId: output.projectId,
          filePath: output.filePath,
          language: output.language,
          chunks: output.chunks.map((c) => ({
            projectId: output.projectId,
            filePath: output.filePath,
            chunkHash: c.chunkHash,
            text: c.text,
            startLine: c.startLine,
            endLine: c.endLine,
            scopeContext: c.scopeContext || "",
          })),
          error: output.error,
        };
        pending.resolve(result);
      }

      // Dispatch next queued item or mark idle
      const next = this.queue.shift();
      if (next) {
        this._dispatch(idx, next);
      } else {
        this.idle.push(idx);
      }
    });

    worker.on("error", (err) => {
      const pending = this.pending.get(idx);
      this.pending.delete(idx);
      pending?.reject(err);
      this._spawn(script); // respawn replacement
    });

    worker.on("exit", (code) => {
      if (code !== 0) {
        this._spawn(script); // respawn on unexpected exit
      }
    });

    this.workers.push(worker);
    this.idle.push(idx);
  }
}
