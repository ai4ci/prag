// @prag/daemon — Thread-safe worker pool for file ingestion
//
// Spawns a pool of worker_threads that handle file reading and structural
// chunking (Tree-sitter). The main thread receives chunk records,
// embeds them via the hot in-memory model, and writes to LanceDB.
//
// Workers never touch the database or the embedding model — ADR-021 split.
//
// Slot-based rather than index-based: a dead worker is replaced *in its slot*,
// so a job can never be posted to the wrong worker (issue:worker-pool-double-
// respawn.md — the previous version keyed pending work by an index that shifted
// when `workers.push()` grew the array, and respawned on both "error" and
// "exit", doubling the pool on every crash).

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
  /** sha256 of the raw bytes — the file_mapping content address. */
  contentHash: string;
  chunks: ChunkRecord[];
  error?: string;
}

export interface WorkerPoolOptions {
  /** Fail a job and recycle the worker if it does not answer in time. */
  jobTimeoutMs?: number;
  /** Worker script override (tests use a fixture worker). */
  workerScript?: string;
  /** Pages of a paginated document a worker will parse (ADR-003); default 500. */
  maxDocumentPages?: number;
}

type Pending = {
  resolve: (r: ProcessResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  input: WorkerInput;
};

type Job = {
  input: WorkerInput;
  resolve: (r: ProcessResult) => void;
  reject: (e: Error) => void;
};

interface Slot {
  id: number;
  worker: Worker | null;
  pending: Pending | null;
}

/** A worker died or hung; its slot has been recycled. */
export class WorkerPoolError extends Error {}

const DEFAULT_JOB_TIMEOUT_MS = 60_000;

// ── WorkerPool ────────────────────────────────────────────────────────

export class WorkerPool {
  private slots: Slot[] = [];
  private queue: Job[] = [];
  private script: string;
  private jobTimeoutMs: number;
  private maxDocumentPages: number | undefined;
  private closed = false;
  private nextId = 0;

  constructor(size: number, options: string | WorkerPoolOptions = {}) {
    // Positional script override is kept for the existing tests/callers.
    const opts: WorkerPoolOptions =
      typeof options === "string" ? { workerScript: options } : options;

    this.script =
      opts.workerScript ??
      resolve(dirname(fileURLToPath(import.meta.url)), "ingestion-worker.ts");
    this.jobTimeoutMs = opts.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
    this.maxDocumentPages = opts.maxDocumentPages;

    for (let i = 0; i < size; i++) {
      this._addSlot();
    }
  }

  /** Submit a file for processing. Resolves when a worker answers. */
  processFile(projectId: string, filePath: string): Promise<ProcessResult> {
    // Carried per job rather than set on the worker at spawn: it is read
    // only when the file turns out to be a document, and a per-job field
    // needs no new plumbing through `_spawn`.
    const input: WorkerInput = {
      projectId, filePath, maxDocumentPages: this.maxDocumentPages,
    };
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new WorkerPoolError("worker pool is closed"));
        return;
      }
      const job: Job = { input, resolve, reject };
      const free = this.slots.find((s) => s.worker && !s.pending);
      if (free) {
        this._run(free, job);
      } else {
        this.queue.push(job);
      }
    });
  }

  /** Terminate all workers. */
  async close(): Promise<void> {
    this.closed = true;
    const doomed: Array<Promise<unknown>> = [];
    for (const slot of this.slots) {
      if (slot.pending) {
        WorkerPool._clearTimer(slot.pending);
        slot.pending.reject(new WorkerPoolError("worker pool closed"));
        slot.pending = null;
      }
      if (slot.worker) doomed.push(slot.worker.terminate());
      slot.worker = null;
    }
    await Promise.allSettled(doomed);

    // Nothing can pick these up any more; fail them instead of hanging callers.
    for (const job of this.queue) {
      job.reject(new WorkerPoolError("worker pool closed"));
    }
    this.queue = [];
    this.slots = [];
  }

  get totalWorkers(): number {
    return this.slots.filter((s) => s.worker).length;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  /** Jobs handed to a worker but not yet answered. */
  get busyCount(): number {
    return this.slots.filter((s) => s.pending).length;
  }

  // ── Internal ──────────────────────────────────────────────────────

  private _addSlot(): void {
    const slot: Slot = { id: this.nextId++, worker: null, pending: null };
    this.slots.push(slot);
    this._spawn(slot);
  }

  private static _clearTimer(pending: Pending): void {
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;
  }

  private _run(slot: Slot, job: Job): void {
    const pending: Pending = {
      resolve: job.resolve,
      reject: job.reject,
      timer: null,
      input: job.input,
    };
    pending.timer = setTimeout(() => {
      pending.timer = null;
      if (slot.pending !== pending) return;
      slot.pending = null;
      pending.reject(
        new WorkerPoolError(
          `worker timed out after ${this.jobTimeoutMs}ms on ${job.input.filePath}`,
        ),
      );
      // A hung worker cannot be reasoned with; recycle the slot.
      this._recycle(slot, "timeout");
    }, this.jobTimeoutMs);
    // A slow model load or big file must not hold the process open.
    pending.timer.unref?.();

    slot.pending = pending;
    slot.worker!.postMessage(job.input);
  }

  /** Replace the worker in a slot exactly once, then take the next queued job. */
  private _recycle(slot: Slot, reason: string): void {
    const dead = slot.worker;
    slot.worker = null;
    if (dead) {
      dead.removeAllListeners();
      void dead.terminate().catch(() => {});
    }
    if (this.closed) return;

    this._spawn(slot);
    const next = this.queue.shift();
    if (next && slot.worker && !slot.pending) this._run(slot, next);
    else if (reason === "timeout") {
      // Nothing queued: the slot simply returns to the idle set.
    }
  }

  private _spawn(slot: Slot): void {
    const worker = new Worker(this.script, {
      workerData: { id: slot.id },
    });
    slot.worker = worker;

    worker.on("message", (output: WorkerOutput) => {
      const pending = slot.pending;
      if (!pending) return; // late message from a job already failed/timed out
      slot.pending = null;
      WorkerPool._clearTimer(pending);

      pending.resolve({
        projectId: output.projectId,
        filePath: output.filePath,
        language: output.language,
        contentHash: output.contentHash ?? "",
        chunks: (output.chunks ?? []).map((c) => ({
          projectId: output.projectId,
          filePath: output.filePath,
          chunkHash: c.chunkHash,
          text: c.text,
          startLine: c.startLine,
          endLine: c.endLine,
          scopeContext: c.scopeContext ?? "",
        })),
        error: output.error,
      });

      const next = this.queue.shift();
      if (next) this._run(slot, next);
    });

    // An uncaught error in the worker and an unexpected exit both arrive here;
    // slot.worker is nulled in _recycle, so the second event is a no-op.
    const die = (reason: string) => {
      if (slot.worker !== worker) return;
      const pending = slot.pending;
      if (pending) {
        slot.pending = null;
        WorkerPool._clearTimer(pending);
        pending.reject(
          new WorkerPoolError(`worker ${reason} on ${pending.input.filePath}`),
        );
      }
      this._recycle(slot, reason);
    };

    worker.on("error", (err: unknown) =>
      die(`errored: ${(err as Error)?.message ?? String(err)}`),
    );
    worker.on("exit", (code) => {
      if (code !== 0) die(`exited with code ${code}`);
    });
  }
}
