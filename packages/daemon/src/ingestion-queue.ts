// @prag/daemon — Chokidar-based ingestion queue with debouncing
//
// Watches registered project directories, debounces file change events
// via cooldown leases (validUntil in file_mapping), applies ADR-023
// discovery filters and the ADR-009 grant policy before enqueuing, and
// dispatches to the WorkerPool.

import chokidar from "chokidar";
import type { FSWatcher } from "chokidar";
import { open, readdir, stat, type FileHandle } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  isBuiltinIgnored, isDenied, DEFAULT_MAX_FILE_BYTES,
  DEFAULT_WATCH_CONFIRM_THRESHOLD, documentCategory,
  DEFAULT_MAX_DOCUMENT_BYTES, type GrantRow,
} from "@prag/core";
import { WorkerPool } from "./worker-pool.js";

/** True when `resolved` is one of `dirs` or sits beneath one. */
function isUnder(resolved: string, dirs: readonly string[]): boolean {
  return dirs.some((dir) => resolved === dir || resolved.startsWith(dir + sep));
}
import { type ProcessResult } from "./worker-pool.js";

// ── Constants ────────────────────────────────────────────────────────

const BINARY_DETECTION_BYTES = 8192;
export const DEFAULT_COOLDOWN_MS = 60_000;
const GRANTS_CACHE_MS = 1_000;

/**
 * How far back each reconcile walk looks beyond the previous walk's start.
 *
 * Covers same-millisecond writes, writes that land during a walk, and
 * filesystems whose mtime granularity is a whole second or two.
 */
const RECONCILE_GRACE_MS = 2_000;

/**
 * Runtime growth defaults (ADR-023).
 *
 * `maxFiles` is deliberately the same number as the `prag watch` confirmation
 * threshold: "20,000 files is enough to ask about" should not mean two
 * different things depending on whether the files arrived before or after
 * registration. The byte limit exists because file count alone misses the
 * other shape of the same accident -- a few thousand very large files.
 */
const DEFAULT_GROWTH_WINDOW_MS = 60_000;
const DEFAULT_GROWTH_MAX_FILES = DEFAULT_WATCH_CONFIRM_THRESHOLD.files;
const DEFAULT_GROWTH_MAX_BYTES = 1024 * 1024 * 1024;

// ── Types ─────────────────────────────────────────────────────────────

export interface IngestionQueueItem {
  projectId: string;
  uri: string;
  eventType: "add" | "change" | "unlink";
}

export interface IngestionConfig {
  cooldownMs?: number;
  maxFileBytes?: number;
  /** Byte cap for the formats in DOCUMENT_FORMATS; default 32MB. */
  maxDocumentBytes?: number;
  poolSize?: number;
  /**
   * Live view of the grants table, consulted at admission (ADR-009). A function
   * rather than an array so a deny takes effect on the next event, not on the
   * next restart.
   */
  grants?: () => GrantRow[] | Promise<GrantRow[]>;
  /** Projects whose status is not 'active' (ADR-023 pause). */
  isPaused?: (projectId: string) => boolean | Promise<boolean>;
  /**
   * Runtime growth bound (ADR-023's confirmation threshold, applied after
   * registration as well as at it). `0` on either limit disables that half.
   */
  growth?: GrowthLimits;
  /**
   * Called when a project's growth breaker trips. The daemon pauses the
   * project; the queue does not know how to, and must not guess.
   */
  onGrowthBreach?: (breach: GrowthBreach) => void;
}

/** Runtime bound on how fast a project may grow before it is held. */
export interface GrowthLimits {
  /** Rolling window, ms. Default 60_000. */
  windowMs?: number;
  /** Files admitted within the window before the breaker trips. Default 20_000. */
  maxFiles?: number;
  /** Bytes admitted within the window before the breaker trips. Default 1 GiB. */
  maxBytes?: number;
}

/** What tripped, and where to look. */
export interface GrowthBreach {
  projectId: string;
  /** Which limit was exceeded first. */
  limit: "files" | "bytes";
  files: number;
  bytes: number;
  windowMs: number;
  /**
   * The immediate child of the project root that contributed the most bytes
   * in this window, if the volume is concentrated in one. Almost always the
   * directory that was moved or cloned in, which is what makes the remedy a
   * single `prag deny` rather than a hunt.
   */
  topDirectory?: string;
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
  /**
   * Projects whose filesystem watcher reported an error, with the last code
   * seen. Almost always `ENOSPC`: the kernel's `fs.inotify.max_user_watches`
   * was exhausted, so an unknown subset of the tree has no watch on it and
   * live edits there are missed until the next reconcile pass.
   *
   * Reported because the alternative is a daemon that looks healthy while
   * quietly not watching. Empty in the normal case.
   */
  watcherErrors: Record<string, string>;
  /**
   * Projects held by the growth breaker, with what tripped it. A held project
   * is `paused`, so this is what distinguishes "the user paused it" from "it
   * was paused for them".
   */
  growthBreaches: Record<string, GrowthBreach>;
}

// ── IngestionQueue ────────────────────────────────────────────────────

/**
 * Queue identity of a file *within a project*. The same path watched by two
 * projects is two pieces of work, not one.
 */
function queueKey(projectId: string, uri: string): string {
  return `${projectId}\0${uri}`;
}

export class IngestionQueue {
  private watchers = new Map<string, FSWatcher>();
  // Keyed by `${projectId}\0${uri}`, not by uri alone. Two projects may hold
  // the same path (overlapping watch roots), and a uri-only key let the second
  // project's event silently overwrite the first's: one ingestion happened and
  // the owning projectId was whichever watcher reported last
  // (issue:ingestion-dirty-set-keyed-by-uri-alone.md). Dedup of identical
  // content belongs in chunks_pool, on content hash (ADR-002), where it is
  // deliberate -- not in the queue's bookkeeping, where it is invisible.
  private dirty = new Map<string, IngestionQueueItem>(); // (projectId, uri) → latest event
  private cooldowns = new Map<string, ReturnType<typeof setTimeout>>(); // (projectId, uri) → timer
  private skipCounters = new Map<string, Record<string, number>>();
  /** Last watcher error code per project; see IngestionStats.watcherErrors. */
  private watcherErrors = new Map<string, string>();
  /** Rolling growth counters per project; see `_recordGrowth`. */
  private growth = new Map<string, {
    since: number; files: number; bytes: number; byDir: Map<string, number>;
  }>();
  /**
   * `${projectId}\0${path}\0${mtimeMs}` of files already counted towards
   * growth, with when they were counted.
   *
   * Growth means new content arriving, not events. The reconcile walk
   * overlaps its previous run by `RECONCILE_GRACE_MS` so that a write landing
   * during a walk is not lost, which means the same unchanged file is
   * legitimately re-examined on the next flush; counting it again would let
   * a steady project accumulate phantom growth and hold itself. Path plus
   * mtime is the cheapest thing at this point in the pipeline that says
   * "same content" -- the hash is not computed until the worker runs.
   *
   * Scoped to the window plus the grace rather than cleared with the window,
   * because the re-examination arrives in the window *after* the one that
   * counted it. Bounded by what the breaker itself admits.
   */
  private growthCounted = new Map<string, number>();
  /**
   * Projects doing a walk the user already consented to -- the initial scan
   * behind `prag watch`'s confirmation prompt, or the rescan that `prag
   * resume` triggers. The breaker is not armed for those, or resuming a
   * project that was held would immediately hold it again.
   */
  private growthSuppressed = new Set<string>();
  /** Projects currently held by the breaker, with what tripped it. */
  private growthBreaches = new Map<string, GrowthBreach>();
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
      maxDocumentBytes: config.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES,
      poolSize: config.poolSize ?? 1,
      grants: config.grants,
      isPaused: config.isPaused,
      growth: config.growth,
      onGrowthBreach: config.onGrowthBreach,
    };
  }

  /** Register a project directory for watching. */
  registerProject(
    projectId: string,
    dirPath: string,
    cooldownMs?: number,
    excludeSubtrees: string[] = [],
  ): void {
    const root = resolve(dirPath);
    const excludes = excludeSubtrees.map((d) => resolve(d));

    const watcher = chokidar.watch(root, {
      persistent: true,
      ignoreInitial: false,
      ignorePermissionErrors: true,
      // Prune at the walk, not after the event. Without this chokidar
      // enumerated and placed an inotify watch on every directory in the tree
      // -- `node_modules` included -- and `_shouldIgnore` threw the results
      // away afterwards. Measured on a tree of 70,000 `node_modules`
      // directories: 3.3s to `ready`, 551MB RSS and **ENOSPC** from the
      // kernel's `max_user_watches`; with this predicate, 6ms, 71MB and no
      // error. The predicate must also skip the excluded child repositories,
      // or a monorepo pays for each of them twice.
      ignored: (candidate: string) =>
        isBuiltinIgnored(candidate, root) || isUnder(resolve(candidate), excludes),
    });

    // chokidar's `ready` marks the end of the initial scan. /sync must not report
    // "drained" before it has even enumerated the tree, so expose the barrier.
    let settleReady: () => void = () => {};
    this.readyPromises.set(
      projectId,
      new Promise<void>((resolve) => { settleReady = resolve; }),
    );
    // The initial scan is the volume the user confirmed at `prag watch`
    // (ADR-023), so the breaker arms only once it has been ingested -- see
    // `_armGrowthBreaker`, called at the end of the flush rather than on
    // chokidar's `ready`. `ready` means the walk finished, not that its files
    // have been through admission; arming there counted the confirmed scan
    // and held the project the moment it was registered.
    this.growthSuppressed.add(projectId);
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
      const code = (err as NodeJS.ErrnoException)?.code;
      this.watcherErrors.set(projectId, code ?? "UNKNOWN");
      if (code === "ENOSPC") {
        // The one worth explaining, because the remedy is a sysctl and
        // nothing in prag can fix it. Coverage is now partial and which
        // directories lost their watch is arbitrary; the reconcile walk on
        // each drain is what still finds changes there.
        console.error(
          `[prag] watcher for ${projectId} ran out of inotify watches (ENOSPC). ` +
          "Some directories are no longer watched; changes there are picked up " +
          "by the periodic rescan instead of immediately. Raise the limit with " +
          "`sysctl fs.inotify.max_user_watches=524288`, or watch a narrower directory.",
        );
        return;
      }
      console.error(
        "[prag] Ingestion watcher error:",
        (err as Error)?.message ?? String(err),
      );
    });

    this.watchers.set(projectId, watcher);
    this.skipCounters.set(projectId, {});
    this.projectDirs.set(projectId, root);
    // Warm the grant cache so the admission gate in `_onEvent` is live for the
    // initial scan rather than only from the second event onwards. Fire and
    // forget: a failure leaves the cache cold, which just defers to the
    // flush-time check.
    void this._currentGrants();
    if (excludes.length > 0) this.projectExcludes.set(projectId, excludes);
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
    this.watcherErrors.delete(projectId);
    this.growth.delete(projectId);
    this.growthSuppressed.delete(projectId);
    this.growthBreaches.delete(projectId);
    this._forgetGrowthCounted(projectId);
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

  /**
   * Directories the filesystem watcher is actually holding open for a project.
   *
   * This is the number that matters for the kernel's
   * `fs.inotify.max_user_watches` budget, and the only way to tell pruning at
   * the walk apart from discarding events afterwards -- both leave the index
   * identical and only this differs. Diagnostic, and what
   * `daemontest:watcher-pruning.test.ts` asserts on.
   */
  watchedDirCount(projectId: string): number {
    const watcher = this.watchers.get(projectId);
    if (!watcher) return 0;
    return Object.keys(watcher.getWatched()).length;
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
      watcherErrors: Object.fromEntries(this.watcherErrors),
      growthBreaches: Object.fromEntries(this.growthBreaches),
    };
  }

  /** Wait for dispatched worker jobs to finish (not new arrivals). */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  // ── Internal ──────────────────────────────────────────────────────

  /**
   * Count an admitted file against the project's rolling growth window, and
   * trip the breaker if it is over.
   *
   * Counted here rather than at `_onEvent` for two reasons: this is the point
   * where the real byte size is known, and it counts only files that would
   * actually have been parsed and embedded, so a flood of denied or binary
   * files cannot trip it.
   *
   * The window is a reset bucket rather than a true sliding window. A burst
   * straddling two buckets is therefore measured as two part-bursts, which in
   * principle lets 2x the limit through -- accepted, because the accident
   * this guards against does not stop at the bucket boundary and trips the
   * next one.
   */
  private _recordGrowth(
    projectId: string,
    filePath: string,
    size: number,
    mtimeMs: number,
  ): void {
    if (this.growthSuppressed.has(projectId)) return;

    const limits = this.config.growth ?? {};
    const windowMs = limits.windowMs ?? DEFAULT_GROWTH_WINDOW_MS;
    const maxFiles = limits.maxFiles ?? DEFAULT_GROWTH_MAX_FILES;
    const maxBytes = limits.maxBytes ?? DEFAULT_GROWTH_MAX_BYTES;
    if (maxFiles <= 0 && maxBytes <= 0) return;

    const now = Date.now();

    // Count content, not events: an unchanged file re-examined by the
    // overlapping reconcile walk is not growth.
    const retainMs = windowMs + RECONCILE_GRACE_MS;
    for (const [k, at] of this.growthCounted) {
      if (now - at > retainMs) this.growthCounted.delete(k);
    }
    const key = `${projectId}\0${filePath}\0${mtimeMs}`;
    if (this.growthCounted.has(key)) return;
    this.growthCounted.set(key, now);
    let w = this.growth.get(projectId);
    if (!w || now - w.since >= windowMs) {
      w = { since: now, files: 0, bytes: 0, byDir: new Map() };
      this.growth.set(projectId, w);
    }
    w.files++;
    w.bytes += size;

    // Attribute to the immediate child of the project root, which is the
    // granularity a `prag deny` is usefully written at.
    const root = this.projectDirs.get(projectId);
    if (root) {
      const rel = relative(root, resolve(filePath));
      const top = rel.split(sep)[0];
      if (top && top !== "..") w.byDir.set(top, (w.byDir.get(top) ?? 0) + size);
    }

    const overFiles = maxFiles > 0 && w.files > maxFiles;
    const overBytes = maxBytes > 0 && w.bytes > maxBytes;
    if (!overFiles && !overBytes) return;

    let topDirectory: string | undefined;
    let most = 0;
    for (const [dir, bytes] of w.byDir) {
      if (bytes > most) { most = bytes; topDirectory = dir; }
    }
    // Only name it when the volume really is concentrated; pointing at a
    // directory holding 5% of the bytes would send the user the wrong way.
    if (most * 2 < w.bytes) topDirectory = undefined;

    const breach: GrowthBreach = {
      projectId,
      limit: overFiles ? "files" : "bytes",
      files: w.files,
      bytes: w.bytes,
      windowMs,
      topDirectory,
    };
    // Suppress immediately: the pause the daemon performs is asynchronous and
    // the rest of this burst is already in the dirty set, so without this the
    // breach fires once per remaining file.
    this.growthSuppressed.add(projectId);
    this.growthBreaches.set(projectId, breach);
    this.growth.delete(projectId);
    this.config.onGrowthBreach?.(breach);
  }

  /** Drop a project's counted-file memory (unregister, or a consented rewalk). */
  private _forgetGrowthCounted(projectId: string): void {
    const prefix = `${projectId}\0`;
    for (const k of this.growthCounted.keys()) {
      if (k.startsWith(prefix)) this.growthCounted.delete(k);
    }
  }

  private _shouldIgnore(filePath: string, projectId?: string): boolean {
    // Same predicate the discovery dry run uses (ADR-023), so the counts a user
    // confirms before `watch` match what the watcher then indexes. Root-relative
    // for the same reason it is there: a project that merely lives under
    // `~/.config`, or inside a directory called `build`, is a project.
    const root = projectId ? this.projectDirs.get(projectId) : undefined;
    if (isBuiltinIgnored(filePath, root)) return true;
    if (!projectId) return false;
    // A nested repository belongs to its own project, so the parent's watcher
    // steps over it rather than indexing the same file twice under two ids.
    const excludes = this.projectExcludes.get(projectId);
    if (!excludes) return false;
    return isUnder(resolve(filePath), excludes);
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
    // Held by the breaker. Checked before `isPaused` and in memory, because
    // the daemon's pause is a database write: without this, the rest of the
    // burst -- already sitting in the dirty set -- would be parsed and
    // embedded in the tens of milliseconds before the status lands, which is
    // exactly the work the breaker exists to prevent. Nothing is lost: the
    // files stay on disk and `prag resume` re-walks the tree.
    if (this.growthBreaches.has(projectId)) return false;
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

      // A document is binary by construction and larger than source, so it is
      // judged against its own cap and skips the NUL test. Same reasoning and
      // same predicate as `probeFile`, so the dry run's promise and what the
      // watcher admits cannot diverge (ADR-023).
      const isDocument = documentCategory(filePath) !== null;
      const sizeCap = isDocument
        ? (this.config.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES)
        : this.config.maxFileBytes;
      if (info.size > sizeCap) {
        this._incrementSkip(projectId, "tooLarge");
        return false;
      }

      if (info.size === 0) {
        this._incrementSkip(projectId, "empty");
        return false;
      }

      if (!isDocument) {
        // Binary detection: read first 8KB for NUL bytes
        const buf = Buffer.alloc(BINARY_DETECTION_BYTES);
        const { bytesRead } = await fd.read(buf, 0, BINARY_DETECTION_BYTES, 0);
        if (buf.subarray(0, bytesRead).includes(0)) {
          this._incrementSkip(projectId, "binary");
          return false;
        }
      }

      this._recordGrowth(projectId, filePath, info.size, info.mtimeMs);
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

  /**
   * Grants already in hand, or null when the cache is cold or stale.
   *
   * Synchronous on purpose: it is read from the chokidar handler, which must
   * not await. A null here means "do not know yet", never "allowed" -- the
   * flush-time check in `_checkFile` is still authoritative.
   */
  private _cachedGrants(): GrantRow[] | null {
    const c = this._grantsCache;
    if (!c) return null;
    return Date.now() - c.at < GRANTS_CACHE_MS ? c.rows : null;
  }

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
    // A full re-walk is deliberate -- `prag resume`, a branch switch -- so it
    // is not what the breaker is looking for. Suppressed until the walk that
    // follows finishes, and the counters are cleared so the walk does not
    // leave a loaded window behind it.
    const suppress = (id: string) => {
      this.growthSuppressed.add(id);
      this.growth.delete(id);
      this.growthBreaches.delete(id);
      this._forgetGrowthCounted(id);
      this.reconciledAt.set(id, 0);
    };
    if (projectId) {
      if (this.projectDirs.has(projectId)) suppress(projectId);
      return;
    }
    for (const id of this.projectDirs.keys()) suppress(id);
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

    // ADR-009 §1: a denied path is refused at admission, not after it has
    // occupied a debounce timer and been dispatched. Only the *policy* half of
    // `_checkFile` runs here -- it is in-memory and cheap. The content probe
    // (size, empty, binary) stays at flush: it is file I/O, debouncing exists
    // precisely to do it once per burst instead of once per event, and it must
    // see the file as it is when the work actually runs.
    //
    // A cold or stale cache returns null, meaning "not known yet", and the file
    // is admitted for the flush-time check to judge. This gate can only reject
    // earlier than before; it can never admit something that was previously
    // refused.
    const known = this._cachedGrants();
    if (known && isDenied(uri, known)) {
      this._incrementSkip(projectId, "denied");
      return;
    }

    const key = queueKey(projectId, uri);

    // Update dirty set with latest event type
    this.dirty.set(key, { projectId, uri, eventType });

    // If already on cooldown, just update the dirty set
    if (this.cooldowns.has(key)) return;

    // Start cooldown timer
    this._startCooldown(key, uri, projectId);
  }

  private _onUnlink(projectId: string, filePath: string): void {
    if (this._closing) return;
    if (this._paused) {
      this._heldEvents.push({ type: "unlink", projectId, filePath });
      return;
    }
    const uri = resolve(filePath);
    const key = queueKey(projectId, uri);

    // Cancel any pending cooldown
    const timer = this.cooldowns.get(key);
    if (timer) {
      clearTimeout(timer);
      this.cooldowns.delete(key);
    }

    this.dirty.delete(key);

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

  private _startCooldown(key: string, uri: string, projectId: string): void {
    const timer = setTimeout(() => {
      this.cooldowns.delete(key);

      // Check if file is still dirty
      const item = this.dirty.get(key);
      if (!item) return;

      this.dirty.delete(key);

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

    this.cooldowns.set(key, timer);
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

    for (const [key, timer] of this.cooldowns) {
      if (projectId && this.dirty.get(key)?.projectId !== projectId) continue;
      clearTimeout(timer);
      this.cooldowns.delete(key);
    }

    const entries = [...this.dirty.entries()].filter(
      ([, item]) => !projectId || item.projectId === projectId,
    );
    for (const [key] of entries) this.dirty.delete(key);
    const items = entries.map(([, item]) => item);

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
    this._armGrowthBreaker(projectId);
    return dispatched;
  }

  /**
   * Arm the growth breaker for every project whose consented walk has now
   * been ingested.
   *
   * Both suppressed cases -- the initial scan behind `prag watch`'s prompt,
   * and the rescan behind `prag resume` -- end the same way: a flush that
   * puts the walk's files through admission. A project held by a breach is
   * skipped, because its suppression is the hold itself and only `rescan`
   * clears that.
   */
  private _armGrowthBreaker(projectId?: string): void {
    const ids = projectId ? [projectId] : [...this.growthSuppressed];
    for (const id of ids) {
      if (this.growthBreaches.has(id)) continue;
      if (!this.growthSuppressed.delete(id)) continue;
      // Drop the window too: the consented files must not count towards the
      // first armed window, or a large confirmed scan would hold the project
      // on the next handful of edits.
      this.growth.delete(id);
    }
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

      // Overlapping, not abutting. The stamp is taken *before* the walk, so
      // a file written while the walk is in progress has an mtime below the
      // next `since` and, with a strict `>` against an exact boundary, would
      // be invisible to this reconcile and to every one after it -- a
      // permanent miss that only a `rescan` or a later edit would undo. The
      // same hole swallows a write landing in the same millisecond as the
      // stamp, and a whole second of writes on a filesystem whose mtime
      // granularity is coarse (many network mounts, and ext3).
      //
      // Re-examination is idempotent: `_ingestFile` short-circuits on the
      // content hash, so an overlap costs a stat and a read, never an embed.
      // That makes a grace window the cheap side of the trade.
      const since = Math.max(0, (this.reconciledAt.get(id) ?? 0) - RECONCILE_GRACE_MS);
      this.reconciledAt.set(id, Date.now());

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
