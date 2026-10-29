// @prag/daemon — Chokidar-based ingestion queue with debouncing
//
// Watches registered project directories, debounces file change events
// via cooldown leases (validUntil in file_mapping), applies ADR-023
// discovery filters before enqueuing, and dispatches to the WorkerPool.

import chokidar from "chokidar";
import { open, type FileHandle } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { WorkerPool } from "./worker-pool.js";
import { type ProcessResult } from "./worker-pool.js";

// ── Constants ────────────────────────────────────────────────────────

const BINARY_DETECTION_BYTES = 8192;
const DEFAULT_COOLDOWN_MS = 60_000;

// ── Types ─────────────────────────────────────────────────────────────

export interface IngestionQueueItem {
  projectId: string;
  uri: string;
  eventType: "add" | "change" | "unlink";
}

export interface IngestionConfig {
  cooldownMs?: number;
  maxFileBytes?: number;
  poolSize?: number;
}

export interface ProjectIngestionState {
  /** Counters for skipped files, keyed by reason */
  skipCounters: Record<string, number>;
}

// ── IngestionQueue ────────────────────────────────────────────────────

export class IngestionQueue {
  private watchers = new Map<string, chokidar.FSWatcher>();
  private dirty = new Map<string, IngestionQueueItem>(); // uri → latest event
  private cooldowns = new Map<string, ReturnType<typeof setTimeout>>(); // uri → timer
  private skipCounters = new Map<string, Record<string, number>>();
  private pool: WorkerPool;
  private config: Required<IngestionConfig>;
  private onFileReady: (result: ProcessResult) => void;

  constructor(
    pool: WorkerPool,
    onFileReady: (result: ProcessResult) => void,
    config: IngestionConfig = {},
  ) {
    this.pool = pool;
    this.onFileReady = onFileReady;
    this.config = {
      cooldownMs: config.cooldownMs ?? DEFAULT_COOLDOWN_MS,
      maxFileBytes: config.maxFileBytes ?? 2 * 1024 * 1024,
      poolSize: config.poolSize ?? 1,
    };
  }

  /** Register a project directory for watching. */
  registerProject(projectId: string, dirPath: string): void {
    const watcher = chokidar.watch(dirPath, {
      persistent: true,
      ignoreInitial: false,
      ignorePermissionErrors: true,
    });

    watcher.on("add", (filePath) => {
      if (!this._shouldIgnore(filePath)) {
        this._onEvent(projectId, filePath, "add");
      }
    });

    watcher.on("change", (filePath) => {
      if (!this._shouldIgnore(filePath)) {
        this._onEvent(projectId, filePath, "change");
      }
    });

    watcher.on("unlink", (filePath) => {
      this._onUnlink(projectId, filePath);
    });

    watcher.on("error", (err) => {
      console.error("[prag] Ingestion watcher error:", err.message);
    });

    this.watchers.set(projectId, watcher);
    this.skipCounters.set(projectId, {});
  }

  /** Unregister a project. */
  unregisterProject(projectId: string): void {
    const watcher = this.watchers.get(projectId);
    watcher?.close();
    this.watchers.delete(projectId);
    this.skipCounters.delete(projectId);
  }

  /** Stop all watchers. */
  async close(): Promise<void> {
    const closers: Array<Promise<void>> = [];
    for (const [projectId, watcher] of this.watchers) {
      closers.push(watcher.close());
      this.skipCounters.delete(projectId);
    }
    this.watchers.clear();
    await Promise.allSettled(closers);

    // Clear pending cooldown timers
    for (const timer of this.cooldowns.values()) {
      clearTimeout(timer);
    }
    this.cooldowns.clear();
    this.dirty.clear();
  }

  /** Get skip counters for a project. */
  getSkipCounters(projectId: string): Record<string, number> {
    return { ...(this.skipCounters.get(projectId) ?? {}) };
  }

  // ── Internal ──────────────────────────────────────────────────────

  private _shouldIgnore(filePath: string): boolean {
    // Skip hidden files and common patterns
    const basename = filePath.split("/").pop() ?? "";
    if (basename.startsWith(".") && basename !== ".gitignore") return true;
    if (basename === "node_modules") return true;
    if (basename === "package-lock.json") return true;
    return false;
  }

  private async _checkFile(
    filePath: string,
    projectId: string,
  ): Promise<boolean> {
    let fd: FileHandle | undefined;
    try {
      fd = await open(filePath, "r");
      const stat = await fd.stat();

      // maxFileBytes check
      if (stat.size > this.config.maxFileBytes) {
        this._incrementSkip(projectId, "tooLarge");
        return false;
      }

      if (stat.size === 0) {
        this._incrementSkip(projectId, "empty");
        return false;
      }

      // Binary detection: read first 8KB for NUL bytes
      const buf = Buffer.alloc(BINARY_DETECTION_BYTES);
      const { bytesRead } = await fd.read(buf, 0, BINARY_DETECTION_BYTES, 0);
      if (buf.subarray(0, bytesRead).includes(0)) {
        this._incrementSkip(projectId, "binary");
        return false;
      }

      return true;
    } catch {
      this._incrementSkip(projectId, "denied");
      return false;
    } finally {
      await fd?.close();
    }
  }

  private _incrementSkip(projectId: string, reason: string): void {
    const counters = this.skipCounters.get(projectId) ?? {};
    counters[reason] = (counters[reason] ?? 0) + 1;
    this.skipCounters.set(projectId, counters);
  }

  private _onEvent(
    projectId: string,
    filePath: string,
    eventType: "add" | "change",
  ): void {
    const uri = resolve(filePath);
    const existing = this.dirty.get(uri);

    // Update dirty set with latest event type
    this.dirty.set(uri, { projectId, uri, eventType });

    // If already on cooldown, just update the dirty set
    if (this.cooldowns.has(uri)) return;

    // Start cooldown timer
    this._startCooldown(uri);
  }

  private _onUnlink(projectId: string, filePath: string): void {
    const uri = resolve(filePath);

    // Cancel any pending cooldown
    const timer = this.cooldowns.get(uri);
    if (timer) {
      clearTimeout(timer);
      this.cooldowns.delete(uri);
    }

    this.dirty.delete(uri);

    // Notify: process unlink immediately
    this.onFileReady({
      projectId,
      filePath: uri,
      language: "",
      chunks: [],
    });
  }

  private _startCooldown(uri: string): void {
    const timer = setTimeout(() => {
      this.cooldowns.delete(uri);

      // Check if file is still dirty
      const item = this.dirty.get(uri);
      if (!item) return;

      this.dirty.delete(uri);

      // Apply discovery filters before dispatching
      this._checkFile(uri, item.projectId).then((pass) => {
        if (!pass) return;

        // Dispatch to worker pool
        this.pool
          .processFile(item.projectId, uri)
          .then((result) => {
            this.onFileReady(result);
          })
          .catch((err) => {
            console.error("[prag] Worker error:", err.message);
          });
      });
    }, this.config.cooldownMs);

    this.cooldowns.set(uri, timer);
  }

  /** Flush all dirty files immediately (used by POST /sync). */
  async flushAll(): Promise<void> {
    for (const [uri, _timer] of this.cooldowns) {
      clearTimeout(_timer);
    }
    this.cooldowns.clear();

    const items = Array.from(this.dirty.entries());
    this.dirty.clear();

    for (const [uri, item] of items) {
      const pass = await this._checkFile(uri, item.projectId);
      if (!pass) continue;

      await this.pool
        .processFile(item.projectId, uri)
        .then((result) => {
          this.onFileReady(result);
        })
        .catch((err) => {
          console.error("[prag] Worker error:", err.message);
        });
    }
  }
}
