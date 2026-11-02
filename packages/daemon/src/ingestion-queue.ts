// @prag/daemon — Chokidar-based ingestion queue with debouncing
//
// Watches registered project directories, debounces file change events
// via cooldown leases (validUntil in file_mapping), applies ADR-023
// discovery filters and the ADR-009 grant policy before enqueuing, and
// dispatches to the WorkerPool.

import chokidar from "chokidar";
import type { FSWatcher } from "chokidar";
import { open, readdir, stat, type FileHandle } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { isBuiltinIgnored, isDenied, DEFAULT_MAX_FILE_BYTES, type GrantRow } from "@prag/core";
import { WorkerPool } from "./worker-pool.js";
import { type ProcessResult } from "./worker-pool.js";

// ── Constants ────────────────────────────────────────────────────────

const BINARY_DETECTION_BYTES = 8192;
export const DEFAULT_COOLDOWN_MS = 60_000;
const GRANTS_CACHE_MS = 1_000;

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
  /**
   * Live view of the grants table, consulted at admission (ADR-009). A function
   * rather than an array so a deny takes effect on the next event, not on the
   * next restart.
   */
  grants?: () => GrantRow[] | Promise<GrantRow[]>;
  /** Projects whose status is not 'active' (ADR-023 pause). */
  isPaused?: (projectId: string) => boolean | Promise<boolean>;
}

export interface ProjectIngestionState {
  /** Counters for skipped files, keyed by reason */
  skipCounters: Record<string, number>;
}

export interface IngestionStats {
  /** Files watched across all projects. */
  projects: number;
  /** Events collected but not yet dispatched. */
  dirty: number;
  /** Files waiting out their cooldown window. */
  cooling: number;
  /** Dispatched to a worker and awaiting its write. */
  inFlight: number;
  perProject: Record<string, Record<string, number>>;
}

// ── IngestionQueue ────────────────────────────────────────────────────

export class IngestionQueue {
  private watchers = new Map<string, FSWatcher>();
  private dirty = new Map<string, IngestionQueueItem>(); // uri → latest event
  private cooldowns = new Map<string, ReturnType<typeof setTimeout>>(); // uri → timer
  private skipCounters = new Map<string, Record<string, number>>();
  private readyPromises = new Map<string, Promise<void>>();
  /** Registered root per project, for the pre-drain reconciliation walk. */
  private projectDirs = new Map<string, string>();
  /**
   * Cooldown per project, from `projects.defaultCooldownSeconds`. A repository of
   * build artefacts wants a longer lease than a hand-edited notes directory, and
   * `watch_uri`/`prag watch --cooldown` are the places a caller says which.
   */
  private projectCooldownMs = new Map<string, number>();
  /**
   * Subtrees a project's watcher must not claim, because another project owns
   * them (ADR-009 §3: a child git repository is its own project). Without this
   * the parent and the child both ingest the same file, under two projectIds.
   */
  private projectExcludes = new Map<string, string[]>();
  /**
   * Wall-clock of each project's last reconciliation walk. Files modified since
   * then are queued even if the watcher never reported them.
   */
  private reconciledAt = new Map<string, number>();
  private inFlight = new Set<Promise<unknown>>();
  private _paused = false;
  /**
   * Set by stopWatchers(): no more events are admitted, and nothing is dispatched
   * afterwards. Without it a chokidar `add` landing during shutdown re-populated
   * the dirty set and its cooldown timer fired after the worker pool had closed,
   * so the write failed with "worker pool is closed" (issue:shutdown-races-…).
   */
  private _closing = false;
  /** Drains currently running, including ones whose caller gave up on them. */
  private _drains = new Set<Promise<number>>();
  private _heldEvents: Array<{
    type: "add" | "change" | "unlink";
    projectId: string;
    filePath: string;
  }> = [];
  private pool: WorkerPool;
  private config: IngestionConfig & {
    cooldownMs: number;
    maxFileBytes: number;
    poolSize: number;
  };
  /**
   * Awaited by the caller, so a drain barrier is possible: returning the write's
   * promise is what lets /sync report "indexed" rather than "queued".
   */
  private onFileReady: (result: ProcessResult) => void | Promise<void>;

  constructor(
    pool: WorkerPool,
    onFileReady: (result: ProcessResult) => void | Promise<void>,
    config: IngestionConfig = {},
  ) {
    this.pool = pool;
    this.onFileReady = onFileReady;
    this.config = {
      cooldownMs: config.cooldownMs ?? DEFAULT_COOLDOWN_MS,
      maxFileBytes: config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      poolSize: config.poolSize ?? 1,
      grants: config.grants,
      isPaused: config.isPaused,
    };
  }

  /** Register a project directory for watching. */
  registerProject(
    projectId: string,
    dirPath: string,
    cooldownMs?: number,
    excludeSubtrees: string[] = [],
  ): void {
    const watcher = chokidar.watch(dirPath, {
      persistent: true,
      ignoreInitial: false,
      ignorePermissionErrors: true,
    });

    // chokidar's `ready` marks the end of the initial scan. /sync must not report
    // "drained" before it has even enumerated the tree, so expose the barrier.
    let settleReady: () => void = () => {};
    this.readyPromises.set(
      projectId,
      new Promise<void>((resolve) => { settleReady = resolve; }),
    );
    watcher.on("ready", settleReady);

    watcher.on("add", (filePath) => {
      if (!this._shouldIgnore(filePath, projectId)) {
        this._onEvent(projectId, filePath, "add");
      }
    });

    watcher.on("change", (filePath) => {
      if (!this._shouldIgnore(filePath, projectId)) {
        this._onEvent(projectId, filePath, "change");
      }
    });

    watcher.on("unlink", (filePath) => {
      this._onUnlink(projectId, filePath);
    });

    watcher.on("error", (err) => {
      console.error(
        "[prag] Ingestion watcher error:",
        (err as Error)?.message ?? String(err),
      );
    });

    this.watchers.set(projectId, watcher);
    this.skipCounters.set(projectId, {});
    this.projectDirs.set(projectId, resolve(dirPath));
    if (excludeSubtrees.length > 0) {
      this.projectExcludes.set(projectId, excludeSubtrees.map((d) => resolve(d)));
    }
    if (cooldownMs && cooldownMs > 0) this.projectCooldownMs.set(projectId, cooldownMs);
    // Force the first drain to reconcile the whole tree.
    this.reconciledAt.set(projectId, 0);
  }

  /**
   * Resolves once the project's initial scan has finished and its events have
   * been queued (not yet ingested). `undefined` for an unknown project.
   */
  scanComplete(projectId?: string): Promise<void> | undefined {
    if (projectId) return this.readyPromises.get(projectId);
    const all = [...this.readyPromises.values()];
    return all.length > 0 ? Promise.all(all).then(() => {}) : undefined;
  }

  /** Unregister a project. */
  unregisterProject(projectId: string): void {
    const watcher = this.watchers.get(projectId);
    watcher?.close();
    this.watchers.delete(projectId);
    this.skipCounters.delete(projectId);
    this.readyPromises.delete(projectId);
    this.projectDirs.delete(projectId);
    this.projectCooldownMs.delete(projectId);
    this.projectExcludes.delete(projectId);
    this.reconciledAt.delete(projectId);
  }

  /** Stop all watchers. */
  /**
   * Close the watchers and refuse further events. Call this before the final
   * drain: a drain that runs while chokidar is still enumerating races the very
   * events it is meant to have finished with.
   */
  async stopWatchers(): Promise<void> {
    this._closing = true;
    const closers: Array<Promise<void>> = [];
    for (const watcher of this.watchers.values()) closers.push(watcher.close());
    this.watchers.clear();
    await Promise.allSettled(closers);
    // A /sync that already timed out is still draining. Wait for it: its dispatches
    // are owed and the pool is still open, so they land instead of erroring.
    await Promise.allSettled([...this._drains]);
    // Whatever the initial scan queued but had not yet debounced into a dispatch
    // is still owed, and it is now the last thing that will ever be queued.
    // _flushAll (not flushAll) because flushAll now refuses once closing.
    await this._flushAll();
  }

  async close(): Promise<void> {
    const closers: Array<Promise<void>> = [];
    for (const [projectId, watcher] of this.watchers) {
      closers.push(watcher.close());
      this.skipCounters.delete(projectId);
    }
    this.watchers.clear();
    this.readyPromises.clear();
    this.projectDirs.clear();
    this.reconciledAt.clear();
    await Promise.allSettled(closers);

    // Clear pending cooldown timers
    for (const timer of this.cooldowns.values()) {
      clearTimeout(timer);
    }
    this.cooldowns.clear();
    this.dirty.clear();
    await this.drain();
  }

  /** Stop collecting new events (existing work still drains). */
  pause(): void {
    this._paused = true;
  }

  /** Resume and replay whatever arrived while paused. */
  resume(): void {
    if (!this._paused) return;
    this._paused = false;
    const held = this._heldEvents.splice(0);
    for (const evt of held) {
      if (evt.type === "unlink") {
        this._onUnlink(evt.projectId, evt.filePath);
      } else {
        this._onEvent(evt.projectId, evt.filePath, evt.type);
      }
    }
  }

  /** Get skip counters for a project. */
  getSkipCounters(projectId: string): Record<string, number> {
    return { ...(this.skipCounters.get(projectId) ?? {}) };
  }

  /** Files queued for ingestion but not yet written to the index. */
  pendingCount(): number {
    return this.dirty.size + this.inFlight.size;
  }

  /** Snapshot for /health and `prag status`. */
  stats(): IngestionStats {
    const perProject: Record<string, Record<string, number>> = {};
    for (const [projectId, counters] of this.skipCounters) {
      perProject[projectId] = { ...counters };
    }
    return {
      projects: this.watchers.size,
      dirty: this.dirty.size,
      cooling: this.cooldowns.size,
      inFlight: this.inFlight.size,
      perProject,
    };
  }

  /** Wait for dispatched worker jobs to finish (not new arrivals). */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  // ── Internal ──────────────────────────────────────────────────────

  private _shouldIgnore(filePath: string, projectId?: string): boolean {
    // Same predicate the discovery dry run uses (ADR-023), so the counts a user
    // confirms before `watch` match what the watcher then indexes.
    if (isBuiltinIgnored(filePath)) return true;
    if (!projectId) return false;
    // A nested repository belongs to its own project, so the parent's watcher
    // steps over it rather than indexing the same file twice under two ids.
    const excludes = this.projectExcludes.get(projectId);
    if (!excludes) return false;
    const resolved = resolve(filePath);
    return excludes.some((dir) => resolved === dir || resolved.startsWith(dir + sep));
  }

  /**
   * Single admission gate (ADR-009 §1 + ADR-023): a URI reaches the worker pool
   * only if it is not ignored, not denied by a grant, under the size/binary
   * limits, and belongs to a project that is not paused. Both the cooldown timer
   * and flushAll() route through here, so a deny cannot be raced by a queued
   * event.
   */
  private async _checkFile(
    filePath: string,
    projectId: string,
  ): Promise<boolean> {
    if (await this.config.isPaused?.(projectId)) return false;

    // Grants are consulted before the file is opened: `prag deny` on a secret
    // means prag never reads it, not merely that it discards the result.
    const grants = await this._currentGrants();
    if (grants && isDenied(filePath, grants)) {
      this._incrementSkip(projectId, "denied");
      return false;
    }

    let fd: FileHandle | undefined;
    try {
      fd = await open(filePath, "r");
      const info = await fd.stat();

      // maxFileBytes check
      if (info.size > this.config.maxFileBytes) {
        this._incrementSkip(projectId, "tooLarge");
        return false;
      }

      if (info.size === 0) {
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
      this._incrementSkip(projectId, "unreadable");
      return false;
    } finally {
      await fd?.close();
    }
  }

  /**
   * Grants, cached briefly. A DB round trip per file would make the scan
   * grant-bound; `invalidateGrants()` covers the case that matters (a deny the
   * daemon just accepted) and the TTL covers writes from another process.
   *
   * shortcut: 1s staleness window for out-of-band grant changes; drop the TTL if
   * grants ever move behind a change notification.
   */
  private _grantsCache: { at: number; rows: GrantRow[] } | null = null;

  private async _currentGrants(): Promise<GrantRow[] | null> {
    const load = this.config.grants;
    if (!load) return null;
    const now = Date.now();
    if (this._grantsCache && now - this._grantsCache.at < GRANTS_CACHE_MS) {
      return this._grantsCache.rows;
    }
    try {
      const rows = await load();
      this._grantsCache = { at: now, rows };
      return rows;
    } catch (err) {
      // Fail closed: an unreadable policy is not permission to index.
      console.error("[prag] grant lookup failed, refusing to ingest:", err);
      return null;
    }
  }

  /** Call after any grant mutation so the next event sees it (ADR-009 §4). */
  invalidateGrants(): void {
    this._grantsCache = null;
  }

  /** True when the project is registered but paused (ADR-023). */
  isRegistered(projectId: string): boolean {
    return this.watchers.has(projectId);
  }

  /** Registered roots, so a deny can un-watch the project that contains it. */
  registeredRoots(): Array<[string, string]> {
    return [...this.projectDirs.entries()];
  }

  /**
   * Force the next drain to walk the whole tree again. Used on resume: files
   * written while paused were dropped by admission, and the incremental walk is
   * mtime-based, so it would otherwise consider them already seen and never
   * revisit them. Re-walking is cheap and idempotent — an unchanged file
   * short-circuits on its content hash in `_ingestFile`.
   */
  rescan(projectId?: string): void {
    if (projectId) {
      if (this.projectDirs.has(projectId)) this.reconciledAt.set(projectId, 0);
      return;
    }
    for (const id of this.projectDirs.keys()) this.reconciledAt.set(id, 0);
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
    // ADR-017: the --gc-chunks sweep pauses ingestion, because dedup is a
    // check-then-act sequence and a concurrent sweep leaves a dangling pointer.
    if (this._paused) {
      this._heldEvents.push({ type: eventType, projectId, filePath });
      return;
    }
    // After stopWatchers() the file stays on disk, and the next daemon start
    // reconciles it; reporting it as pending is what pendingCount() still does.
    if (this._closing) return;
    const uri = resolve(filePath);
    const existing = this.dirty.get(uri);

    // Update dirty set with latest event type
    this.dirty.set(uri, { projectId, uri, eventType });

    // If already on cooldown, just update the dirty set
    if (this.cooldowns.has(uri)) return;

    // Start cooldown timer
    this._startCooldown(uri, projectId);
  }

  private _onUnlink(projectId: string, filePath: string): void {
    if (this._closing) return;
    if (this._paused) {
      this._heldEvents.push({ type: "unlink", projectId, filePath });
      return;
    }
    const uri = resolve(filePath);

    // Cancel any pending cooldown
    const timer = this.cooldowns.get(uri);
    if (timer) {
      clearTimeout(timer);
      this.cooldowns.delete(uri);
    }

    this.dirty.delete(uri);

    // Notify: process unlink immediately
    this._dispatch(
      this.onFileReady({
        projectId,
        filePath: uri,
        language: "",
        contentHash: "",
        chunks: [],
      }),
    );
  }

  /** Track a dispatched result so drain()/flushAll() can await it. */
  private _dispatch(work: unknown): void {
    if (work && typeof (work as Promise<unknown>).then === "function") {
      const p = Promise.resolve(work as Promise<unknown>).catch((err) => {
        console.error("[prag] ingestion write failed:", err);
      });
      this.inFlight.add(p);
      p.finally(() => this.inFlight.delete(p));
    }
  }

  private _startCooldown(uri: string, projectId: string): void {
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
        this._dispatch(
          this.pool
            .processFile(item.projectId, uri)
            .then((result) => this.onFileReady(result)),
        );
      });
    }, this.projectCooldownMs.get(projectId) ?? this.config.cooldownMs);

    this.cooldowns.set(uri, timer);
  }

  /**
   * Drain: dispatch everything queued, await the workers, then await the
   * writes they triggered. Only returns once the index reflects the disk, which
   * is what makes `prag sync && prag search` behave.
   *
   * `projectId` narrows the drain to one project (ADR-019); other projects keep
   * their debounce timers, which is why the cooldown clear is filtered too.
   *
   * Returns how many files were dispatched for ingestion — the number /sync
   * reports as `flushedFiles`. Counting `before - after` instead was wrong for a
   * project whose initial scan had not queued anything yet: it read 0 pending at
   * call time and then reported a drain that flushed nothing.
   */
  async flushAll(projectId?: string): Promise<number> {
    // A drain that returns after SYNC_TIMEOUT keeps running unsupervised in the
    // handler; if nothing tracks it, stop() closes the worker pool underneath it
    // and the write dies with "worker pool is closed". Registering it is what lets
    // shutdown wait for it instead of racing it.
    const drain = this._flushAll(projectId);
    this._drains.add(drain);
    try {
      return await drain;
    } finally {
      this._drains.delete(drain);
    }
  }

  private async _flushAll(projectId?: string): Promise<number> {
    // A drain started during shutdown could dispatch after the pool closes, and
    // the caller cannot act on the answer anyway. Report nothing flushed; the next
    // start reconciles from zero and indexes what is still on disk.
    if (this._closing) return 0;

    // Trust the disk, not event delivery (see _reconcile).
    await this._reconcile(projectId);

    for (const [uri, timer] of this.cooldowns) {
      if (projectId && this.dirty.get(uri)?.projectId !== projectId) continue;
      clearTimeout(timer);
      this.cooldowns.delete(uri);
    }

    const items = Array.from(this.dirty.values()).filter(
      (item) => !projectId || item.projectId === projectId,
    );
    for (const item of items) this.dirty.delete(item.uri);

    let dispatched = 0;
    for (const item of items) {
      const pass = await this._checkFile(item.uri, item.projectId);
      if (!pass) continue;

      dispatched++;
      this._dispatch(
        this.pool
          .processFile(item.projectId, item.uri)
          .then((result) => this.onFileReady(result)),
      );
    }

    await this.drain();
    return dispatched;
  }

  /**
   * URIs still waiting to be written, optionally for one project. Only the
   * queued ones are nameable — `inFlight` holds promises — so a stall inside a
   * worker is reported by `pendingFiles` count rather than by name.
   */
  pendingUris(projectId?: string): string[] {
    return [...this.dirty.values()]
      .filter((item) => !projectId || item.projectId === projectId)
      .map((item) => item.uri);
  }

  /**
   * Queue every file on disk that the watcher has not reported since the last
   * reconciliation, so a drain reflects the filesystem rather than whatever
   * inotify happened to deliver.
   *
   * A drain can otherwise miss a file written microseconds earlier: the watcher
   * is asynchronous, so /sync would find an empty dirty set and report "drained"
   * while the file sat unindexed — and if the event is coalesced or dropped, it
   * stays unindexed until the next touch. `prag sync && prag search` is the
   * contract here, so the check is against disk, not against event delivery.
   *
   * Deletions are deliberately not reconciled: `prag prune` owns that.
   *
   * shortcut: stats the whole tree per drain, fine for the corpora prag indexes
   * today; upgrade to watching a directory-mtime frontier if /sync gets slow.
   */
  private async _reconcile(projectId?: string): Promise<void> {
    // During shutdown the walk would mark files as seen while `_onEvent` refuses
    // them, so nothing must be recorded here. The next start reconciles from zero
    // and picks up whatever this one did not reach.
    if (this._closing) return;

    const ids = projectId ? [projectId] : [...this.projectDirs.keys()];
    for (const id of ids) {
      const dir = this.projectDirs.get(id);
      if (!dir) continue;

      const since = this.reconciledAt.get(id) ?? 0;
      const now = Date.now();
      this.reconciledAt.set(id, now);

      const stack = [dir];
      while (stack.length > 0) {
        const current = stack.pop()!;
        let entries;
        try {
          entries = await readdir(current, { withFileTypes: true });
        } catch {
          continue; // unreadable directory: the watcher reports it as `denied`
        }
        for (const entry of entries) {
          const full = join(current, entry.name);
          if (entry.isDirectory()) {
            // `id`, not a bare path test: this walk runs per project, and a
            // subtree owned by a nested project must not be descended into on
            // its parent's behalf (ADR-009 §3). Omitting it here let the
            // reconcile path re-add every child repository's file to the
            // parent, bypassing the watcher's exclusion entirely.
            if (!this._shouldIgnore(full, id)) stack.push(full);
            continue;
          }
          if (!entry.isFile() || this._shouldIgnore(full, id)) continue;
          try {
            const info = await stat(full);
            // mtime, not content hash: hashing the tree per drain is worse, and a
            // false positive just re-runs an idempotent ingestion.
            if (info.mtimeMs > since) this._onEvent(id, full, "change");
          } catch {
            /* vanished between readdir and stat */
          }
        }
      }
    }
  }
}
