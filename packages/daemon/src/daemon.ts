// @prag/daemon — Local HTTP daemon for prag
//
// Binds to 127.0.0.1, authenticates via PRAG_API_KEY, and exposes
// endpoints: GET /health, POST /search, GET /projects, POST /projects,
// POST /sync, POST /shutdown, and GET/POST /mcp for the MCP SSE interface.

import {
  createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, statSync, existsSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";

import {
  type LanceDbSchema,
  type EmbeddingProvider,
  type SearchResult,
  type SearchMode,
  type GrantRow,
  resolvePragPaths,
  type PragPaths,
  hybridSearch,
  discoveryDryRun,
  pathToGrantPattern,
  grantPatternToPath,
  DEFAULT_WATCH_CONFIRM_THRESHOLD,
  upsertGrants,
  upsertProjects,
  upsertFileMapping,
  upsertChunkMapping,
  upsertChunksPool,
  upsertVectorPool,
  upsertBranchMapping,
  resolveBranch,
  isGitWorkspace,
  listGitBranches,
  DEFAULT_BRANCH,
  evaluateUriGrants,
  DaemonFailure,
  HTTP_STATUS_FOR_CODE,
  type ErrorCode,
  approximateTokenizer,
  type Tokenizer,
  splitVectorUnits,
  DEFAULT_MAX_VECTOR_UNIT_TOKENS,
  DEFAULT_VECTOR_UNIT_OVERLAP_TOKENS,
  API_VERSION,
  requireCapability,
  type WebFetchBackend,
  isDenied,
  chunkDocumentOrCode,
  DEFAULT_MAX_FILE_BYTES,
  type FreshnessHint,
} from "@prag/core";

import { McpHandler } from "./mcp-server.js";
import { assertProjectRegistered } from "./project-lookup.js";
import { WorkerPool } from "./worker-pool.js";
import {
  IngestionQueue, DEFAULT_COOLDOWN_MS,
  type GrowthBreach, type GrowthLimits,
} from "./ingestion-queue.js";
import { type ProcessResult } from "./worker-pool.js";

// ── Config ────────────────────────────────────────────────────────────

const DEFAULT_PORT = 7724; // used by main.ts via loadConfig()
export { DEFAULT_PORT };
export { API_VERSION };

/**
 * Package semver, for diagnostics only (ADR-016: never compared). Read from this
 * package's own package.json so it cannot go stale on a release bump -- it was a
 * second literal, and the two agreed only by luck.
 */
export const DAEMON_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: string;
  }
).version ?? "0.0.0";

/** How long a cached grants/status read may be reused during a scan. */
const STATUS_CACHE_MS = 1_000;

/** Endpoints still served while the index has a model mismatch (ADR-015). */
export const MISMATCH_ALLOWED = new Set(["/health", "/reembed", "/shutdown"]);

/** Routes that exist but accept POST only — used to answer 405 rather than 404. */
const POST_ONLY_ROUTES = new Set([
  "/search",
  "/projects/watch",
  "/grants",
  "/grants/evaluate",
  "/sync",
  "/prune",
  "/reembed",
  "/pause",
  "/resume",
  "/shutdown",
]);

/** Chunks per embedBatch call when the caller does not override it. */
const DEFAULT_EMBEDDING_BATCH = 32;
/** ADR-008 default web freshness lease when config.json names none: 24h. */
const DEFAULT_WEB_COOLDOWN_SECONDS = 86_400;
/** How often expired web leases are swept. */
const DEFAULT_WEB_REFRESH_MS = 15 * 60_000;
/**
 * Pages one `prag watch <origin>` will index. A bound is required: `discover`
 * reports what a site advertises, and a sitemap with 50k URLs would otherwise
 * become 50k fetches and embeds from a single command.
 */
const DEFAULT_WEB_MAX_PAGES = 200;

/**
 * A filename-shaped string for a URL, so the parser router can pick a chunker.
 *
 * The router keys off the extension (markdown vs code vs other), and a URL
 * usually has none. The content type decides when it does not: HTML has
 * already been reduced to prose by the backend, which chunks far better as a
 * document than as source.
 */
function webPseudoPath(url: string, contentType?: string): string {
  const path = new URL(url).pathname;
  const named = /\.[a-z0-9]{1,6}$/i.test(path) ? path : "";
  if (named) return named;
  if (contentType && /html|markdown|plain/i.test(contentType)) return "page.md";
  return "page.md";
}

/** ADR-019: how long POST /sync may take before it reports what is outstanding. */
export const DEFAULT_SYNC_TIMEOUT_MS = 60_000;

class SyncTimeoutError extends Error {
  constructor(readonly phase: string) {
    super(`sync ${phase} timed out`);
  }
}

/** Reject once `deadline` has passed, and stop holding the timer open. */
async function withDeadline(work: Promise<void>, deadline: number, phase: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new SyncTimeoutError(phase)), Math.max(0, deadline - Date.now()));
  });
  try {
    await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface DaemonConfig {
  port?: number;
  token?: string;
  paths?: PragPaths;
  ingestion?: {
    cooldownMs?: number;
    maxFileBytes?: number;
    poolSize?: number;
    /** ADR-019 bound on POST /sync; default DEFAULT_SYNC_TIMEOUT_MS. */
    syncTimeoutMs?: number;
    /** ADR-023 admission threshold for `prag watch` on a container directory. */
    watchConfirmThreshold?: { projects: number; files: number };
    /**
     * ADR-023 runtime growth bound. The confirmation threshold above only
     * applies at registration; this is the same question asked of a project
     * that is already being watched.
     */
    growth?: GrowthLimits;
  };
  /** ADR-024: the selected web fetch backend, or null for local-only. */
  webBackend?: WebFetchBackend | null;
  /** Pages one site crawl will index; default 200. */
  webMaxPagesPerSite?: number;
  /** ADR-008 lease for web content, seconds. `0` means never re-fetch. */
  webCooldownSeconds?: number;
  /** How often expired web leases are swept. `0` disables the sweep. */
  webRefreshIntervalMs?: number;
  /** Model id the daemon embeds with (resolved by bootstrap). */
  embeddingModel?: string;
  /** ADR-014 window size; clamped to the model ceiling by bootstrap. */
  maxVectorUnitTokens?: number;
  vectorUnitOverlapTokens?: number;
  /** Chunks per embedBatch call. */
  batchSize?: number;
  /** When true, /shutdown skips process.exit() — used by in-memory test harness. */
  noExit?: boolean;
}

/** Tunables `bootstrap()` derives from the active provider. */
export interface DaemonOptions {
  maxVectorUnitTokens?: number;
  vectorUnitOverlapTokens?: number;
  embeddingBatchSize?: number;
  /** Set when the index was built by another model (ADR-015 degraded mode). */
  mismatch?: Error;
  /**
   * ADR-015: rebuild the embedding space under `modelId` (or the configured
   * model when omitted) and hand back the fresh handles.
   *
   * Injected rather than imported so the daemon stays out of model resolution
   * and weight loading. It must work when the daemon is running degraded with
   * no db and no embedder, because that is precisely the state `/reembed`
   * exists to escape.
   */
  rebuild?: (modelId?: string) => Promise<RebuildResult>;
}

/** What a rebuild hands back once the new embedding space exists on disk. */
export interface RebuildResult {
  schema: LanceDbSchema;
  provider: EmbeddingProvider;
  maxVectorUnitTokens: number;
}

// ── Daemon ────────────────────────────────────────────────────────────

export class Daemon {
  private server: ReturnType<typeof createServer> | null = null;
  private startTime = 0;
  private db: LanceDbSchema | null = null;
  private embedder: EmbeddingProvider | null = null;
  private mcpHandler: McpHandler | null = null;
  private ingestionQueue: IngestionQueue | null = null;
  private workerPool: WorkerPool | null = null;
  private token: string;
  readonly paths: PragPaths;
  private _boundPort: number | null = null;
  private _noExit: boolean;
  private _options: DaemonOptions = {};
  /** ADR-015: set when the index's embedding space does not match the model. */
  private _mismatch: Error | null = null;
  /** ADR-008 periodic web refresh; null when no backend is configured. */
  private _webRefreshTimer: ReturnType<typeof setInterval> | null = null;
  /** Guards against two concurrent POST /reembed sweeps. */
  private _reembedding = false;
  /** In-flight ingestion writes; /sync waits for these to settle. */
  private _inflight = new Set<Promise<void>>();
  /** Files the worker failed on, so /sync can report them. */
  private _failed = new Set<string>();

  constructor(
    readonly config: DaemonConfig,
  ) {
    this.token = config.token ?? "guest";
    this.paths = config.paths ?? resolvePragPaths();
    this._noExit = config.noExit ?? false;
  }

  /**
   * Start the HTTP server.
   *
   * `db`/`embedder` are injected rather than built here so tests can run the
   * whole surface with a fake provider. Passing nulls is ADR-015 degraded mode:
   * only /health, /reembed and /shutdown are served.
   */
  async start(
    db: LanceDbSchema | null,
    embedder: EmbeddingProvider | null,
    options: DaemonOptions = {},
  ): Promise<void> {
    this.db = db;
    this.embedder = embedder;
    this._options = options;
    this._mismatch = options.mismatch ?? null;
    if (db && embedder) {
      // Thunked through `this` so the handler reaches the daemon's own policy
      // methods, not a copy of them.
      this.mcpHandler = new McpHandler(db, embedder, {
        watchUri: (o) => this.watchUri(o),
        applyGrant: (pattern, action, reason) => this.applyGrant(pattern, action, reason),
        prune: (gcChunks) => this.prune(gcChunks),
        statusFor: (uri) => this.statusFor(uri),
        currentBranch: (projectId) => this.currentBranchFor(projectId),
      });
    }

    // Start ingestion pipeline if configured
    const ingConfig = this.config.ingestion;
    if (ingConfig?.poolSize !== undefined && ingConfig.poolSize > 0) {
      this.workerPool = new WorkerPool(ingConfig.poolSize);
      this.ingestionQueue = new IngestionQueue(
        this.workerPool,
        // Returning the promise is what lets flushAll() be a drain barrier:
        // the queue awaits every write before reporting the file done.
        (result) => this.trackWrite(this._onFileProcessed(result)),
        {
          cooldownMs: ingConfig.cooldownMs,
          maxFileBytes: ingConfig.maxFileBytes,
          // ADR-009 §1: policy is consulted at admission, on every event, so a
          // `prag deny` stops a file from being read without a restart.
          grants: () => this._grantRows(),
          // ADR-023: a paused project stops scanning; nothing else changes.
          isPaused: (projectId) => this._projectPaused(projectId),
          growth: ingConfig.growth,
          onGrowthBreach: (breach) => { void this._holdProject(breach); },
        },
      );
    }

    // ADR-008: web leases expire on a clock, not on a filesystem event, so
    // something has to come looking. unref'd so it never holds the process
    // open, and skipped entirely when there is no backend to refresh through.
    if (this.config.webBackend && (this.config.webRefreshIntervalMs ?? 0) !== 0) {
      const every = this.config.webRefreshIntervalMs ?? DEFAULT_WEB_REFRESH_MS;
      this._webRefreshTimer = setInterval(() => {
        void this.refreshExpiredWebContent().catch((err) => {
          console.error("[prag] web refresh sweep failed:", err);
        });
      }, every);
      this._webRefreshTimer.unref?.();
    }

    this.startTime = Date.now();

    this.server = createServer((req, res) => this._handle(req, res));
    // A loopback server that never times out keeps a worker thread's event loop
    // referenced for the lifetime of a stuck client: an SSE reader that goes away
    // without closing, or a request whose body never arrives, would hold shutdown
    // open. Headers are read server-side in full before dispatch, so a 10s header
    // window cannot cut off a legitimately slow caller -- only a stalled one.
    this.server.requestTimeout = 60_000;
    this.server.headersTimeout = 10_000;
    this.server.keepAliveTimeout = 5_000;

    await new Promise<void>((resolve, reject) => {
      // Without this, EADDRINUSE -- the one failure a user can act on -- surfaced as
      // an unhandled 'error' event and killed the process with a bare stack trace,
      // instead of the message cli-and-mcp-interface.md specifies.
      this.server!.once("error", reject);
      this.server!.listen(this.config.port, "127.0.0.1", () => {
        this.server!.removeAllListeners("error");
        // After bind, a listen error is not recoverable; log rather than throw from
        // inside an http callback where nothing can catch it.
        this.server!.on("error", (err) => {
          console.error(`[prag] server error: ${err.message}`);
        });
        const addr = this.server!.address();
        if (addr && typeof addr === "object") {
          this._boundPort = addr.port;
        }
        resolve();
      });
    });
  }

  /** Graceful shutdown. */
  async stop(): Promise<void> {
    if (this._webRefreshTimer) {
      clearInterval(this._webRefreshTimer);
      this._webRefreshTimer = null;
    }
    // Drain queued work first: close() used to discard the dirty set, so files
    // changed shortly before shutdown were silently never indexed.
    if (this.ingestionQueue) {
      try {
        // Watchers first, then drain: flushing while chokidar is still enumerating
        // left writes arriving after the pool closed (issue:shutdown-races-…).
        await this.ingestionQueue.stopWatchers();
      } catch (err) {
        console.error("[prag] flush during shutdown failed:", err);
      }
      await this.ingestionQueue.close();
    }
    await this.awaitInflight();
    if (this.workerPool) {
      await this.workerPool.close();
    }
    if (this.mcpHandler) {
      await this.mcpHandler.close();
    }
    return new Promise((resolve) => {
      if (this.server) {
        // Force-close all connections (SSE, keep-alive) so server.close()
        // resolves immediately instead of waiting for clients to disconnect.
        this.server.closeAllConnections();
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  get boundPort(): number | null {
    return this._boundPort;
  }

  get listening(): boolean {
    return this.server?.listening ?? false;
  }

  /** Run an ingestion write, tracked so /sync and stop() can await it. */
  private trackWrite(promise: Promise<void>): Promise<void> {
    const tracked = promise.catch((err) => {
      console.error("[prag] ingestion write failed:", err);
    });
    this._inflight.add(tracked);
    tracked.finally(() => this._inflight.delete(tracked));
    return tracked;
  }

  /**
   * Wait for ingestion writes currently in flight (one drain pass). Writes are not
   * tracked per project, so a scoped /sync also waits for other projects' writes —
   * stricter than required, never looser.
   */
  private async awaitInflight(): Promise<void> {
    while (this._inflight.size > 0) {
      await Promise.allSettled([...this._inflight]);
    }
  }

  /**
   * Branch whose pointers new content belongs to, read from the project root's
   * `.git/HEAD`. Deliberately uncached: `git checkout` rewrites HEAD and then the
   * working tree within milliseconds, so any cache at all attributes the files the
   * checkout touched to the branch you left. One stat + one read per file write is
   * noise beside the DB round-trips it sits between.
   *
   * Non-git workspaces get `$default`.
   */
  async currentBranchFor(projectId: string): Promise<string> {
    const root = this.ingestionQueue?.registeredRoots().find(([id]) => id === projectId)?.[1];
    // A project with no watcher (registered before ingestion existed, or via a
    // bare POST /projects) has no root to read HEAD from, so it has no branch.
    return root ? resolveBranch(root) : DEFAULT_BRANCH;
  }

  /** Register a project directory for file watching. */
  registerProject(
    projectId: string,
    dirPath: string,
    cooldownMs?: number,
    excludeSubtrees: string[] = [],
  ): void {
    if (!this.ingestionQueue) {
      throw new Error("Ingestion not enabled (set ingestion.poolSize > 0)");
    }
    this.ingestionQueue.registerProject(projectId, dirPath, cooldownMs, excludeSubtrees);
  }

  /**
   * Drop the ingestion queue's cached grants so a policy change applies to the
   * next event rather than after a restart (ADR-009 §4).
   */
  invalidateGrantCache(): void {
    this.ingestionQueue?.invalidateGrants();
  }

  /**
   * Excluded paths under a root, so `prag deny` can report what it unpicks
   * instead of silently dropping rows. Deliberately not a deletion: pool rows are
   * content-addressed and shared, and `--gc-chunks` owns reclaiming them.
   */
  /**
   * Exclude paths from search by removing their `file_mapping`/`chunk_mapping`
   * rows. Pool rows are content-addressed and shared, so they are left alone —
   * `--gc-chunks` owns reclamation (issue:unlink-prune-deletes-shared-pool-rows).
   */
  async purgeDenied(pattern: string): Promise<string[]> {
    const denied = await this._matchingFilePaths(pattern);
    for (const filePath of denied) await this._handleUnlink(filePath);
    return denied;
  }

  private async _grantRows(): Promise<GrantRow[]> {
    if (!this.db) return [];
    return (await this.db.table("grants").query().toArray()) as unknown as GrantRow[];
  }

  private async _projectPaused(projectId: string): Promise<boolean> {
    return (await this._pausedProjects()).has(projectId);
  }


  /**
   * Set of paused project ids, cached briefly for the same reason grants are:
   * admission runs per file, and a DB round trip per file would make a scan
   * status-bound. `pause`/`resume` invalidate it, so the CLI's own pause takes
   * effect on the very next event.
   *
   * shortcut: 1s staleness for a pause issued by another process.
   */
  private _pausedCache: { at: number; ids: Set<string> } | null = null;

  private async _pausedProjects(): Promise<Set<string>> {
    if (!this.db) return new Set();
    const now = Date.now();
    if (this._pausedCache && now - this._pausedCache.at < STATUS_CACHE_MS) {
      return this._pausedCache.ids;
    }
    const rows = (await this.db
      .table("projects")
      .query()
      .filter("status = 'paused'")
      .limit(1000)
      .toArray()) as Array<{ projectId: string }>;
    const ids = new Set(rows.map((r) => String(r.projectId)));
    this._pausedCache = { at: now, ids };
    return ids;
  }

  /** Indexed file paths (from `file_mapping`) covered by a grant pattern. */
  private async _matchingFilePaths(pattern: string): Promise<string[]> {
    if (!this.db) return [];
    const rows = (await this.db
      .table("file_mapping")
      .query()
      .toArray()) as unknown as Array<{ uri: string }>;
    const denyGrants: GrantRow[] = [
      { pattern, action: "deny", reason: "user_deny", createdAt: new Date() },
    ];
    return rows
      .map((r) => String(r.uri))
      .filter((p) => {
        try {
          return evaluateUriGrants(pathToFileURL(p).href, denyGrants).action === "deny";
        } catch {
          return false;
        }
      });
  }

  private async _onFileProcessed(result: ProcessResult): Promise<void> {
    if (!this.db || !this.embedder) return;

    // One write chain per path. Two ingests of the same file are routinely in
    // flight together — a watcher event landing while a drain has already
    // dispatched that path — and each does read-then-write: both query
    // file_mapping, both see nothing, both insert, and branch_mapping ends up
    // with duplicate (projectId, branch, uri) rows even though
    // upsertBranchMapping merges on exactly that key. LanceDB merge has no
    // unique constraint to fall back on, so the ordering has to be enforced here.
    const path = result.filePath;
    const apply = () => this._applyFileResult(result);
    const prev = this._pathWrites.get(path) ?? Promise.resolve();
    const mine = prev.then(apply, apply); // a failed predecessor must not block the path
    this._pathWrites.set(path, mine);
    try {
      await mine;
    } finally {
      if (this._pathWrites.get(path) === mine) this._pathWrites.delete(path);
    }
  }

  private _pathWrites = new Map<string, Promise<void>>();

  private async _applyFileResult(result: ProcessResult): Promise<void> {
    if (!this.db || !this.embedder) return;

    if (result.error) {
      // The file stays un-indexed and is reported by /sync; the pool is
      // unaffected (issue:worker-pool-double-respawn.md owns crash handling).
      console.error("[prag] Ingestion error for", result.filePath, ":", result.error);
      this._failed.add(result.filePath);
      return;
    }

    // Unlink: remove from file_mapping
    if (result.chunks.length === 0 && result.language === "") {
      await this._handleUnlink(result.filePath);
      return;
    }

    // Add/change: embed + upsert
    await this._ingestFile(result);
  }

  /**
   * Drop a file's index entries. Pool rows are content-addressed and shared
   * across files and projects, so they are only removed once no remaining
   * chunk_mapping row points at them (issue:unlink-prune-deletes-shared-pool-rows).
   * Reclaiming vectors for still-referenced-but-rarely-used chunks is
   * `--gc-chunks`' job, not this one.
   */
  private async _handleUnlink(filePath: string): Promise<void> {
    if (!this.db) return;

    const fmTable = this.db.table("file_mapping");
    const escaped = filePath.replace(/'/g, "''");
    const existing = await fmTable.query()
      .filter(`uri = '${escaped}'`)
      .limit(100)
      .toArray() as Array<{ fileVersionId: string; projectId: string }>;

    if (existing.length === 0) return;

    // The watcher reports an unlink for the tree it watches, which is one branch.
    // Drop that branch's pointer and let the version go only if nothing else
    // holds it — a file deleted on a feature branch is still indexed on main.
    const projectId = String(existing[0].projectId ?? "");
    const branch = await this.currentBranchFor(projectId);
    const where = `projectId = '${projectId.replace(/'/g, "''")}' AND branch = '${branch.replace(/'/g, "''")}' AND uri = '${escaped}'`;
    await this.db
      .table("branch_mapping")
      .delete(where);

    for (const row of existing as Array<{ fileVersionId: string }>) {
      await this._retireVersionIfUnreferenced(String(row.fileVersionId));
    }
    // No pool delete here. The hash may be referenced by any other file,
    // project or branch, and reclamation is the explicit --gc-chunks sweep's
    // job (ADR-017, issue:unlink-prune-deletes-shared-pool-rows).
  }

  // ── Web ingestion (ADR-024, task:web-ingestion-pipeline.md) ─────────

  /**
   * Normalized project id for a web URI: scheme + host, no path.
   *
   * Every page of a site belongs to one project, so a search can be scoped to
   * "the LanceDB docs" rather than to one page. `branch` is always `$default`
   * -- a web document has no branches to disambiguate (CAS schema).
   */
  static webProjectId(uri: string): string {
    const u = new URL(uri);
    return `${u.protocol}//${u.host}`;
  }

  /**
   * ADR-008/ADR-024: how long the fetched copy may be trusted.
   *
   * A cached copy gets the *remaining* life of the lease, not a full one --
   * the content was already `ageSeconds` old when the backend handed it over,
   * and granting it a full window would make the index staler than the
   * configured policy allows. A backend with no cache always reports `live`.
   */
  private _webLease(freshness: FreshnessHint): Date | null {
    const seconds = this.config.webCooldownSeconds ?? DEFAULT_WEB_COOLDOWN_SECONDS;
    if (seconds <= 0) return null; // explicitly permanent: never re-fetched
    const used = freshness.kind === "cached" ? (freshness.ageSeconds ?? 0) : 0;
    // Floor at a minute rather than the past: a lease already expired on
    // arrival would have the refresh scan re-fetch it immediately, forever.
    const remaining = Math.max(60, seconds - used);
    return new Date(Date.now() + remaining * 1000);
  }

  /**
   * Fetch one granted URL through the configured backend and index it.
   *
   * Opt-in only: the grants table is consulted here, not merely at the point
   * the URL was registered, because a backend may hand back URLs the user
   * never named and a `deny` on a child of an allowed prefix has to win
   * (ADR-009).
   */
  async ingestWebUri(uri: string): Promise<{ indexed: boolean; reason?: string }> {
    if (!this.db || !this.embedder) {
      throw new DaemonFailure("SERVICE_UNAVAILABLE", "the index is not available");
    }
    const backend = requireCapability(this.config.webBackend ?? null, "fetch", uri);

    // `evaluateUriGrants`, not `isDenied`: the latter takes a filesystem path
    // and runs pathToFileURL over it, so an http URL becomes a nonsense
    // file:// URI that matches nothing and is silently "allowed".
    //
    // Opt-in means an explicit `allow` must match (ADR-009 deny-by-default);
    // "not denied" is not the same thing and would fetch anything a backend
    // happened to return.
    const grants = await this._grantRows();
    const verdict = grants ? evaluateUriGrants(uri, grants) : null;
    if (!verdict || verdict.action !== "allow") {
      // Not an error: a crawl legitimately turns up URLs the policy excludes,
      // and reporting each as a failure would make a normal run look broken.
      return { indexed: false, reason: verdict?.action === "deny" ? "denied" : "not-granted" };
    }

    const maxBytes = this.config.ingestion?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    const fetched = await backend.fetch!(uri, { maxBytes });

    // The backend may have redirected; re-check the URL actually retrieved, or
    // an allow on one host becomes a way to index another.
    if (fetched.url !== uri && evaluateUriGrants(fetched.url, grants!).action !== "allow") {
      return { indexed: false, reason: "denied-after-redirect" };
    }

    const text = fetched.text.slice(0, maxBytes);
    if (text.trim() === "") return { indexed: false, reason: "empty" };

    // Backend text is data, never instructions: it is hashed, chunked and
    // embedded exactly like file content and is never interpreted.
    const projectId = Daemon.webProjectId(fetched.url);

    // The site is a project in its own right, or a scoped search cannot name
    // it and `currentBranchFor` has no row to resolve against. isGit false and
    // branch `$default`: a web document has no branches to disambiguate.
    await upsertProjects(this.db.table("projects"), [{
      projectId,
      rootUri: projectId,
      name: new URL(projectId).host,
      isGit: false,
      defaultCooldownSeconds: this.config.webCooldownSeconds ?? DEFAULT_WEB_COOLDOWN_SECONDS,
      status: "active",
      registeredAt: new Date(),
      lastSyncedAt: new Date(),
    }]);

    const chunked = chunkDocumentOrCode(webPseudoPath(fetched.url, fetched.contentType), text);

    await this._ingestFile(
      {
        projectId,
        filePath: fetched.url,
        language: chunked.language,
        contentHash: createHash("sha256").update(text).digest("hex"),
        chunks: chunked.chunks.map((c) => ({
          ...c,
          projectId,
          filePath: fetched.url,
          scopeContext: c.scopeContext ?? "",
        })),
      },
      { validUntil: this._webLease(fetched.freshness) },
    );
    return { indexed: true };
  }

  /**
   * Enumerate a granted site and index the pages the grants admit.
   *
   * The crawl half of `task:web-ingestion-pipeline.md`. `discover` names the
   * URLs; each is then put through `ingestWebUri`, which re-checks the grants
   * — a backend is free to return URLs the user never named, and a `deny` on
   * a child of an allowed prefix has to win (ADR-009).
   *
   * Serial, deliberately. Embedding is on the main thread by ADR-021, so
   * parallel fetches would only queue behind it, and a crawler that opens N
   * connections to one host is the behaviour `rateLimitMs` exists to prevent.
   * The bound that matters is `maxPages`, not concurrency.
   */
  async ingestWebSite(
    rootUri: string,
    opts: { maxPages?: number } = {},
  ): Promise<{ discovered: number; indexed: number; skipped: number; failed: number }> {
    if (!this.db || !this.embedder) {
      throw new DaemonFailure("SERVICE_UNAVAILABLE", "the index is not available");
    }
    const maxPages = opts.maxPages ?? this.config.webMaxPagesPerSite ?? DEFAULT_WEB_MAX_PAGES;
    const backend = requireCapability(this.config.webBackend ?? null, "discover", rootUri);

    const found = await backend.discover!(rootUri, { limit: maxPages });

    let indexed = 0;
    let skipped = 0;
    let failed = 0;
    for (const url of found.urls.slice(0, maxPages)) {
      try {
        const out = await this.ingestWebUri(url);
        if (out.indexed) indexed++;
        else skipped++;
      } catch (err) {
        // One unreachable or unparseable page must not abandon the crawl.
        // Counted and logged, so a site that is mostly failing is visible
        // rather than silently thin.
        failed++;
        console.error(`[prag] web ingest failed for ${url}:`, err);
      }
    }
    return { discovered: found.urls.length, indexed, skipped, failed };
  }

  /**
   * ADR-008: re-fetch web content whose lease has expired.
   *
   * Only expired rows, and `_ingestFile` compares content hashes, so an
   * unchanged page costs one fetch and a lease refresh rather than a re-embed.
   * `validUntil IS NULL` is permanent and never revisited.
   */
  async refreshExpiredWebContent(now: Date = new Date()): Promise<{ checked: number; reindexed: number }> {
    if (!this.db || !this.config.webBackend) return { checked: 0, reindexed: 0 };
    const rows = (await this.db
      .table("file_mapping")
      .query()
      .limit(10000)
      .toArray()) as Array<{ uri: string; validUntil: Date | null; contentHash: string }>;

    const due = rows.filter(
      (r) => /^https?:\/\//.test(r.uri) && r.validUntil != null && new Date(r.validUntil) <= now,
    );

    let reindexed = 0;
    for (const row of due) {
      try {
        const before = row.contentHash;
        await this.ingestWebUri(row.uri);
        const after = (await this.db
          .table("file_mapping")
          .query()
          .filter(`uri = '${row.uri.replace(/'/g, "''")}'`)
          .limit(1)
          .toArray()) as Array<{ contentHash: string }>;
        if (after[0] && after[0].contentHash !== before) reindexed++;
      } catch (err) {
        // One unreachable page must not stop the sweep: the lease stays
        // expired and the next scan retries it.
        console.error(`[prag] web refresh failed for ${row.uri}:`, err);
      }
    }
    return { checked: due.length, reindexed };
  }

  private async _ingestFile(
    result: ProcessResult,
    /**
     * Lease for this content. Local files use the ingestion cooldown; web
     * content uses `defaults.webCooldownSeconds`, shortened when the backend
     * served a cached copy (ADR-008/ADR-024). `null` means no expiry -- a
     * permanently static document that the refresh scan never revisits.
     */
    leaseOverride?: { validUntil: Date | null },
  ): Promise<void> {
    if (!this.db || !this.embedder) return;
    const lease = (): Date | null =>
      leaseOverride ? leaseOverride.validUntil : this.cooldownExpiry();

    const fmTable = this.db.table("file_mapping");
    const uri = result.filePath;
    const esc = uri.replace(/'/g, "''");

    // Content-addressable file version: the address is the sha256 of the bytes,
    // so an unchanged file re-reported by the watcher resolves to the same row
    // and nothing is re-embedded (ADR-017).
    const contentHash = result.contentHash;
    const existing = (await fmTable
      .query()
      .filter(`uri = '${esc}'`)
      .limit(1)
      .toArray()) as Array<Record<string, unknown>>;
    const current = existing[0];

    const branch = await this.currentBranchFor(result.projectId);

    if (current && current.contentHash === contentHash) {
      // Refresh the lease only; the index is already correct.
      await fmTable.update({
        values: { validUntil: lease() },
        where: `fileVersionId = '${current.fileVersionId as string}'`,
      });
      // But the *pointer* may not be: after `git checkout` the same content is now
      // the current version on a different branch, and moving that row is the whole
      // cost of the switch — zero re-parsing, zero vector computation.
      await this._pointBranch(result.projectId, branch, uri, current.fileVersionId as string);
      return;
    }

    // ADR-014: one vector per vectorised unit, so an oversized chunk is embedded
    // as several overlapping windows under one chunkHash rather than truncated.
    const { tokenizer, maxTokens, overlap } = this._unitSplit(this.embedder);

    const unitsPerChunk = result.chunks.map((c) =>
      splitVectorUnits(c.text, c.scopeContext ?? "", tokenizer, maxTokens, overlap),
    );

    const flat: string[] = [];
    for (const units of unitsPerChunk) flat.push(...units);

    // Embed in batches — one call per chunk unit set, never one giant request.
    const batchSize = this._options.embeddingBatchSize ?? DEFAULT_EMBEDDING_BATCH;
    const vectors: Float32Array[] = [];
    for (let i = 0; i < flat.length; i += batchSize) {
      vectors.push(...(await this.embedder.embedBatch(flat.slice(i, i + batchSize))));
    }

    // `${uri}::${contentHash}`, per storage-schema.md:128 -- NOT the content
    // hash alone. A file version is a version *of a path*: using the hash by
    // itself gave two projects holding byte-identical files the same primary
    // key, and `upsertFileMapping` merges on it, so ingesting the second
    // deleted the first. `corpus/alpha/src/shared.ts` and
    // `corpus/beta/src/shared.ts` are byte-identical precisely to exercise this
    // (test/fixtures/README.md), and alpha's copy vanished from its own index.
    // Content-level dedup still happens, in chunks_pool on chunkHash (ADR-002),
    // which is where it is deliberate.
    const fileVersionId = `${uri}::${contentHash}`;
    const cmRows: Array<{ fileVersionId: string; chunkIndex: number; chunkHash: string }> = [];
    const cpRows: Array<{ chunkHash: string; text: string; scopeContext: string | null }> = [];
    const vpRows: Array<{ chunkHash: string; unitIndex: number; vector: Float32Array }> = [];

    let cursor = 0;
    for (let i = 0; i < result.chunks.length; i++) {
      const c = result.chunks[i];
      cmRows.push({ chunkHash: c.chunkHash, fileVersionId, chunkIndex: i });
      cpRows.push({
        chunkHash: c.chunkHash,
        text: c.text,
        scopeContext: c.scopeContext || null,
      });
      for (let u = 0; u < unitsPerChunk[i].length; u++) {
        const vector = vectors[cursor++];
        if (vector) vpRows.push({ chunkHash: c.chunkHash, unitIndex: u, vector });
      }
    }

    await upsertFileMapping(fmTable, [{
      fileVersionId,
      projectId: result.projectId,
      uri,
      validUntil: lease(),
      contentHash,
      language: result.language,
    }]);

    await upsertChunkMapping(this.db.table("chunk_mapping"), cmRows);
    await upsertChunksPool(this.db.table("chunks_pool"), cpRows);
    await upsertVectorPool(this.db.table("vector_pool"), vpRows);

    // This branch's pointer now names the new version.
    await this._pointBranch(result.projectId, branch, uri, fileVersionId);

    // The path moved to new content on *this* branch. Other branches keep pointing
    // at their historical version, so the old row is retired only once no pointer
    // references it (git-branch-awareness: "Other branches continue pointing to
    // their respective historical fileVersionId"). Pool rows are never touched
    // here — they are shared by content address (issue:unlink-prune-deletes-shared-pool-rows).
    if (current && current.fileVersionId !== fileVersionId) {
      await this._retireVersionIfUnreferenced(String(current.fileVersionId));
    }
  }

  /** Point (projectId, branch, uri) at a file version. */
  private async _pointBranch(
    projectId: string,
    branch: string,
    uri: string,
    fileVersionId: string,
  ): Promise<void> {
    if (!this.db) return;
    await upsertBranchMapping(this.db.table("branch_mapping"), [{
      branch,
      projectId,
      uri,
      fileVersionId,
      updatedAt: new Date(),
    }]);
  }

  /**
   * Delete a file version's pointer rows, but only when no branch points at it any
   * more. Deleting eagerly is what made a checkout destroy another branch's index.
   */
  private async _retireVersionIfUnreferenced(fileVersionId: string): Promise<void> {
    if (!this.db) return;
    const esc = fileVersionId.replace(/'/g, "''");
    const holders = await this.db
      .table("branch_mapping")
      .query()
      .filter(`fileVersionId = '${esc}'`)
      .limit(1)
      .toArray();
    if (holders.length > 0) return;

    await this.db.table("chunk_mapping").delete(`fileVersionId = '${esc}'`);
    await this.db.table("file_mapping").delete(`fileVersionId = '${esc}'`);
  }

  /** Cooldown lease written to file_mapping.validUntil (ADR-023). */
  private cooldownExpiry(): Date {
    const ms = this.config.ingestion?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    return new Date(Date.now() + ms);
  }

  // ── Request handling ──────────────────────────────────────────────

  private async _handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const addr = req.socket.remoteAddress;
    if (addr !== "127.0.0.1" && addr !== "::1" && addr !== "::ffff:127.0.0.1") {
      this.sendError(res, 401, "ORIGIN_REJECTED", "prag only accepts loopback connections",
        "Connect over 127.0.0.1; prag has no remote mode by design.");
      return;
    }

    const origin = req.headers["origin"];
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
      // 401, not 403: ADR-022 §2 groups a rejected Origin with an auth failure.
      this.sendError(res, 401, "ORIGIN_REJECTED", `Origin header '${origin}' is not a local origin`,
        "Call prag from a page served on 127.0.0.1 or localhost.");
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname !== "/health" && req.method !== "OPTIONS") {
      const auth = req.headers["authorization"];
      if (!auth || !auth.startsWith("Bearer ") || auth.slice(7) !== this.token) {
        this.sendError(res, 401, "UNAUTHORIZED", "missing or invalid bearer token",
      "Send `Authorization: Bearer <PRAG_API_KEY>`; see `prag daemon token`.");
        return;
      }
    }

    if (url.pathname === "/mcp") {
      if (this.mcpHandler) {
        return this.mcpHandler.handle(req, res, url);
      }
      this.sendError(res, 503, "SERVICE_UNAVAILABLE", "the index is not open",
        "Start the daemon with `prag daemon start` and retry.");
      return;
    }

    // ADR-015: with a mismatched index only these three remain served.
    if (this._mismatch && !MISMATCH_ALLOWED.has(url.pathname)) {
      this.sendError(res, 409, "EMBEDDING_MODEL_MISMATCH", this._mismatch.message,
        "Run `prag reembed` to rebuild the index with the active model.");
      return;
    }

    if (req.method === "GET") {
      if (url.pathname === "/health") return this._handleHealth(req, res);
      if (url.pathname === "/projects") return this._handleGetProjects(req, res);
      if (url.pathname === "/grants") return this._handleGetGrants(req, res);
      this.sendError(res, 404, "NOT_FOUND", `no handler for ${req.method} ${url.pathname}`);
      return;
    }

    if (req.method === "POST") {
      if (url.pathname === "/search") return this._handleSearch(req, res);
      if (url.pathname === "/projects") return this._handlePostProjects(req, res);
      if (url.pathname === "/projects/watch") return this._handleWatchUri(req, res);
      if (url.pathname === "/grants") return this._handlePostGrants(req, res);
      if (url.pathname === "/grants/evaluate") return this._handleEvaluateGrants(req, res);
      if (url.pathname === "/sync") return this._handleSync(req, res);
      if (url.pathname === "/prune") return this._handlePrune(req, res);
      if (url.pathname === "/reembed") return this._handleReembed(req, res);
      if (url.pathname === "/pause") return this._handlePauseResume(req, res, "paused");
      if (url.pathname === "/resume") return this._handlePauseResume(req, res, "active");
      if (url.pathname === "/shutdown") return this._handleShutdown(req, res);
      this.sendError(res, 404, "NOT_FOUND", `no handler for ${req.method} ${url.pathname}`);
      return;
    }

    if (req.method === "DELETE") {
      if (url.pathname === "/grants") return this._handleDeleteGrants(req, res);
      // A route that exists but not for this verb is 405, not 404: the difference
      // tells a client whether to fix the path or the method (ADR-022).
      if (POST_ONLY_ROUTES.has(url.pathname)) {
        this.sendError(res, 405, "METHOD_NOT_ALLOWED", `${req.method} is not allowed on ${url.pathname}`);
        return;
      }
      this.sendError(res, 404, "NOT_FOUND", `no handler for ${req.method} ${url.pathname}`);
      return;
    }

    this.sendError(res, 405, "METHOD_NOT_ALLOWED", `${req.method} is not allowed on ${url.pathname}`);
  }

  private async _handleHealth(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: this._mismatch ? "mismatch" : "ok",
      service: "prag-daemon",
      apiVersion: API_VERSION,
      pid: process.pid,
      version: DAEMON_VERSION,
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      // The port actually bound, which is not config.port when PRAG_PORT=0.
      port: this._boundPort ?? this.config.port ?? null,
      root: this.paths.root || null,
      dataDir: this.paths.dataDir,
      configDir: this.paths.configDir,
      runDir: this.paths.runDir,
      // ADR-016: what is loaded, so a client can tell a fake index from a real one.
      embeddingModel: this.embedder?.model ?? null,
      embeddingDim: this.embedder?.dim ?? null,
      // The execution provider actually in use, not the one requested: a
      // configured accelerator that failed to initialise falls back to CPU,
      // and a user who cannot see that assumes they are getting acceleration
      // they are not (task:local-first-enforcement.md). `null` before the
      // model has loaded, or for a provider with no device concept.
      // ADR-024 §2: the current egress path is always inspectable, even when
      // it is "none".
      webBackend: this.config.webBackend
        ? { id: this.config.webBackend.id, endpoint: this.config.webBackend.endpoint,
            capabilities: [...this.config.webBackend.capabilities].sort() }
        : null,
      embeddingDevice:
        (this.embedder as { activeDevice?: string | null } | null)?.activeDevice ?? null,
      maxVectorUnitTokens: this._options.maxVectorUnitTokens ?? null,
      ingestion: this.ingestionQueue ? this.ingestionQueue.stats() : null,
      ...(this._mismatch
        ? { mismatch: { message: this._mismatch.message, served: [...MISMATCH_ALLOWED] } }
        : {}),
    }));
  }

  /** ADR-022 error envelope — the shape the CLI and MCP clients parse. */
  private sendError(
    res: ServerResponse,
    status: number,
    code: ErrorCode,
    message: string,
    remedy?: string,
    details?: Record<string, unknown>,
  ): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code, message, remedy, details } }));
  }

  /**
   * 500 is the only status whose response may be generic (ADR-022 §4): the
   * detail goes to the daemon log with its stack, not to a response that may
   * reach an agent.
   */
  private sendInternal(
    res: ServerResponse,
    code: ErrorCode,
    message: string,
    err: unknown,
  ): void {
    console.error(`[prag] ${message}:`, err);
    this.sendError(res, 500, code, message, "See the daemon log for the underlying error.");
  }

  /** Answers with the status implied by the code, so the two cannot drift. */
  private sendFailure(res: ServerResponse, failure: DaemonFailure): void {
    const status = HTTP_STATUS_FOR_CODE[failure.code as ErrorCode] ?? 400;
    this.sendError(
      res,
      status,
      failure.code as ErrorCode,
      failure.message,
      failure.remedy,
      failure.details,
    );
  }

  private async _handleSearch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    let queryOpts: Record<string, unknown>;
    try {
      queryOpts = JSON.parse(body);
    } catch {
      this.sendError(res, 400, "INVALID_REQUEST", "request body is not valid JSON",
        "Send a JSON object with Content-Type: application/json");
      return;
    }

    const queryText = queryOpts.query as string | undefined;
    const limit = (queryOpts.limit as number) ?? 10;
    const projectId = queryOpts.projectId as string | undefined;
    const mode = (queryOpts.mode as SearchMode) ?? "hybrid";
    // The caller resolves the branch (the CLI from .git/HEAD, an MCP client from its
    // own context): the daemon has no working directory of its own to answer for.
    // Omitted means "every branch", NOT `$default` — see task:search-project-scoping.
    const branch = queryOpts.branch as string | undefined;

    if (!queryText) {
      this.sendError(res, 400, "INVALID_REQUEST", "'query' field is required");
      return;
    }

    // A branch identifies a version of *one* repository, so it scopes nothing on
    // its own. Accepting it silently would answer "all branches" to a caller that
    // asked for one.
    if (branch && !projectId) {
      this.sendError(res, 400, "INVALID_REQUEST", "'branch' requires 'projectId'",
        "A branch names a version of one project's files; send the projectId it belongs to.");
      return;
    }

    if (!this.db || !this.embedder) {
      this.sendError(res, 503, "SERVICE_UNAVAILABLE", "the index is not open",
        "Start the daemon with `prag daemon start` and retry.");
      return;
    }

    // ADR-018: an unknown project is a client error, not an empty result set —
    // silently returning nothing would look like "no matches" to an agent.
    if (projectId) {
      try {
        await assertProjectRegistered(this.db, projectId);
      } catch (err) {
        this.sendFailure(res, err as DaemonFailure);
        return;
      }
    }

    try {
      const result: SearchResult = await hybridSearch(
        this.db.table("chunks_pool"),
        this.db.table("vector_pool"),
        this.db.table("chunk_mapping"),
        this.db.table("file_mapping"),
        this.embedder,
        queryText,
        limit,
        50,
        { projectId, mode, branch, branchMapping: this.db.table("branch_mapping") },
      );

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      // The detail belongs in the log, not in a response that may reach an agent
      // (ADR-022 §4), so a search failure never leaks a query into a message.
      console.error("[prag] search failed:", err);
      this.sendError(res, 500, "SEARCH_FAILED", "the search could not be completed",
        "See the daemon log for the underlying error.");
    }
  }

  private async _handleGetProjects(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.db) {
      this.sendError(res, 503, "SERVICE_UNAVAILABLE", "the index is not open",
        "Start the daemon with `prag daemon start` and retry.");
      return;
    }

    try {
      const rows = await this.db.table("projects").query().limit(1000).toArray();
      const projects = (rows as Array<Record<string, unknown>>).map((row) => {
        const projectId = String(row.projectId);
        return {
          projectId,
          rootUri: row.rootUri,
          status: row.status,
          // Per-scan, in-memory skip counters (ADR-023): the only way a user can
          // tell "deliberately skipped" from "missing because of a bug".
          skipped: this.ingestionQueue?.getSkipCounters(projectId) ?? {},
        };
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(projects));
    } catch (err) {
      this.sendInternal(res, "INTERNAL", "could not list projects", err);
    }
  }

  private async _handlePostProjects(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    let projectOpts: Record<string, unknown>;
    try {
      projectOpts = JSON.parse(body);
    } catch {
      this.sendError(res, 400, "INVALID_REQUEST", "request body is not valid JSON",
        "Send a JSON object with Content-Type: application/json");
      return;
    }

    const projectId = projectOpts.projectId as string | undefined;
    let rootUri = projectOpts.rootUri as string | undefined;

    if (!projectId || !rootUri) {
      this.sendError(res, 400, "INVALID_REQUEST", "both 'projectId' and 'rootUri' are required");
      return;
    }

    // Strip file:// prefix for filesystem operations
    const dirPath = rootUri.replace(/^file:\/\//, "");

    try {
      statSync(dirPath);
    } catch {
      this.sendError(res, 400, "INVALID_REQUEST", `directory '${dirPath}' does not exist`);
      return;
    }

    // Store a canonical file URL: callers send either a bare path or a file:// URI,
    // and every reader (branch resolution, inferProjectId, `prag projects`) would
    // otherwise have to accept both. /projects/watch already stores it this way.
    rootUri = pathToFileURL(dirPath).href;

    // Upsert project in DB
    if (this.db) {
      await upsertProjects(this.db.table("projects"), [{
        projectId,
        rootUri,
        name: projectId,
        isGit: false,
        defaultCooldownSeconds: 60,
        status: "active",
        registeredAt: new Date(),
        lastSyncedAt: null,
      }]);
    }

    // Register watcher
    try {
      this.registerProject(projectId, dirPath);
    } catch (err) {
      // 500 is the only status whose message may name the internals (ADR-022 §4).
      this.sendError(res, 500, "INTERNAL", "could not register the project",
        "Check the daemon log; ingestion may be disabled (ingestion.workerPoolSize).");
      console.error("[prag] registerProject failed:", err);
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ projectId, rootUri, status: "active" }));
  }

  /**
   * POST /projects/watch — the grant-gated registration path (ADR-009 §5,
   * ADR-023): write the allow grant, dry-run discovery, and only then watch.
   *
   * Order matters. Past the threshold without `confirm` nothing is written at
   * all, so a refusal leaves no half-applied policy behind.
   */
  private async _handleWatchUri(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req).catch(() => null);
    let opts: { uri?: string; projectId?: string; confirm?: boolean } = {};
    if (body) {
      try {
        opts = JSON.parse(body);
      } catch {
        /* treated as a missing uri below */
      }
    }
    let outcome: Record<string, unknown>;
    try {
      outcome = await this.watchUri(opts);
    } catch (err) {
      if (err instanceof DaemonFailure) return this.sendFailure(res, err);
      return this.sendInternal(res, "INTERNAL", "could not watch the project", err);
    }
    // Written only once the operation has succeeded: answering 200 first and
    // then failing leaves the client with a half response.
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(outcome));
  }

  /**
   * Grant, register and watch a directory — the whole of `prag watch`, and the
   * MCP `watch_uri` tool. Throws `DaemonFailure` rather than answering, so the
   * HTTP route and the tool cannot drift into two different behaviours; ADR-022
   * requires both to report the same code, and a tool that merely echoed a
   * narrower answer would let an agent believe a refusal was a transport error.
   */
  async watchUri(opts: {
    uri?: string;
    projectId?: string;
    confirm?: boolean;
    cooldownSeconds?: number;
  }): Promise<Record<string, unknown>> {
    if (!this.db) {
      throw new DaemonFailure(
        "SERVICE_UNAVAILABLE",
        "the index is not open",
        "Start the daemon with `prag daemon start` and retry.",
      );
    }


    const rootUri = opts.uri;
    if (!rootUri) {
      throw new DaemonFailure("INVALID_REQUEST", "'uri' is required");
    }
    if (!rootUri.startsWith("file://")) {
      // A bare origin means "the site" and needs `discover`; anything with a
      // path is one document and needs `fetch`. The rule has to be *some*
      // rule -- a URL does not say which the user meant -- and this one is at
      // least predictable from the URL alone. `requireCapability` covers the
      // no-backend case too, which is the same refusal to a user.
      const parsed = new URL(rootUri);
      const wantsSite = parsed.pathname === "" || parsed.pathname === "/";
      requireCapability(this.config.webBackend ?? null, wantsSite ? "discover" : "fetch", rootUri);

      await upsertGrants(this.db.table("grants"), [{
        pattern: rootUri + (wantsSite ? "/**" : ""),
        action: "allow",
        reason: "watch_root",
        createdAt: new Date(),
      }]);
      this.invalidateGrantCache();

      if (wantsSite) {
        const crawled = await this.ingestWebSite(rootUri);
        const projectId = Daemon.webProjectId(rootUri);
        return {
          projectId,
          rootUri,
          status: crawled.indexed > 0 ? "active" : "skipped",
          registered: crawled.indexed > 0 ? [projectId] : [],
          discovered: {
            projects: 1,
            files: crawled.indexed,
            // Reported the way a local scan reports its skips, so `prag watch`
            // on a site and on a directory read the same way: a page the
            // grants excluded is `denied`, one that failed to fetch is
            // `errored`. A crawl that indexes nothing is not an error --
            // the grant is written and the refresh sweep will retry.
            skipped: {
              ...(crawled.skipped > 0 ? { denied: crawled.skipped } : {}),
              ...(crawled.failed > 0 ? { errored: crawled.failed } : {}),
            },
          },
        };
      }

      const out = await this.ingestWebUri(rootUri);
      const projectId = Daemon.webProjectId(rootUri);
      return {
        projectId,
        rootUri,
        status: out.indexed ? "active" : "skipped",
        registered: out.indexed ? [projectId] : [],
        discovered: { projects: 1, files: out.indexed ? 1 : 0, skipped: {} },
      };
    }

    if (!this.ingestionQueue) {
      // Only the file path needs the pool: a watcher and a parse worker are
      // what it buys. Web ingestion fetches and chunks on the main thread, so
      // demanding workers for it refused a request that would have worked.
      // Distinct from "the index is not open": the daemon is up and
      // searchable, so the remedy is a config change and a restart.
      throw new DaemonFailure(
        "SERVICE_UNAVAILABLE",
        "ingestion is disabled on this daemon, so nothing can be watched",
        "Set ingestion.poolSize > 0 in config.json (or PRAG_POOL_SIZE) and restart the daemon.",
      );
    }

    const dirPath = fileURLToPath(rootUri);
    try {
      statSync(dirPath);
    } catch {
      throw new DaemonFailure(
        "INVALID_REQUEST",
        `directory '${dirPath}' does not exist`,
      );
    }

    const dryRun = await discoveryDryRun(dirPath, await this._grantRows(), {
      maxFileBytes: this.config.ingestion?.maxFileBytes,
      threshold: this.config.ingestion?.watchConfirmThreshold,
    });

    if (dryRun.exceedsThreshold && !opts.confirm) {
      // An agent has no terminal to confirm at, so the counts go in `details`
      // for it to put to the user (ADR-023).
      throw new DaemonFailure(
        "WATCH_LIMIT_EXCEEDED",
        `watching ${dirPath} would register ${dryRun.projects} projects / ${dryRun.files} files`,
        "Re-send with confirm: true (CLI: --yes) to proceed",
        {
          projects: dryRun.projects,
          files: dryRun.files,
          threshold: dryRun.threshold ?? DEFAULT_WATCH_CONFIRM_THRESHOLD,
        },
      );
    }

    await upsertGrants(this.db.table("grants"), [{
      pattern: pathToGrantPattern(dirPath, "allow"),
      action: "allow",
      reason: "watch_root",
      createdAt: new Date(),
    }]);
    this.invalidateGrantCache();

    const projectId = opts.projectId ?? dirPath;
    // A caller-supplied lease wins; otherwise the daemon's configured default.
    const cooldownMs =
      opts.cooldownSeconds !== undefined
        ? Math.max(0, Math.round(opts.cooldownSeconds * 1000))
        : this.config.ingestion?.cooldownMs ?? DEFAULT_COOLDOWN_MS;

    // ADR-009 §3: a git repository under the watched root is an autonomous
    // project, not part of its parent. Discovery used to count them and throw
    // the paths away, so one row covered the whole tree and per-repository
    // scoping did not exist. Each gets its own row and its own watcher, and the
    // parent's watcher steps over them so a file is never ingested twice.
    const resolvedRoot = resolve(dirPath);
    const childRepos = dryRun.repos.filter((r) => resolve(r) !== resolvedRoot);

    const registrations: Array<{ projectId: string; dirPath: string; excludes: string[] }> = [
      { projectId, dirPath, excludes: childRepos },
      ...childRepos.map((repo) => ({
        // The caller's projectId names the root only; a child repo is a
        // different project and must not inherit an id that already exists.
        projectId: repo,
        dirPath: repo,
        // Repos nested inside this one are its children, not the root's.
        excludes: childRepos.filter((o) => o !== repo && resolve(o).startsWith(resolve(repo) + sep)),
      })),
    ];

    await upsertProjects(this.db.table("projects"), registrations.map((r) => ({
      projectId: r.projectId,
      rootUri: pathToFileURL(r.dirPath).href,
      name: basename(r.dirPath),
      // isGitWorkspace, not a statSync().isDirectory() check: a linked worktree's
      // `.git` is a file, and every worktree was being recorded as non-git.
      isGit: isGitWorkspace(r.dirPath),
      defaultCooldownSeconds: Math.round(cooldownMs / 1000),
      status: "active",
      registeredAt: new Date(),
      lastSyncedAt: null,
    })));

    const registered: string[] = [];
    for (const r of registrations) {
      try {
        this.registerProject(r.projectId, r.dirPath, cooldownMs, r.excludes);
        registered.push(r.projectId);
      } catch (err) {
        // Unwind: a half-watched tree would report success while indexing an
        // arbitrary subset of the repositories the user just granted.
        for (const done of registered) this.ingestionQueue?.unregisterProject(done);
        throw new DaemonFailure(
          "INTERNAL",
          "could not watch the project",
          "See the daemon log for the underlying error.",
          { cause: err instanceof Error ? err.message : String(err) },
        );
      }
    }

    return {
      projectId,
      rootUri: pathToFileURL(dirPath).href,
      status: "active",
      // Every id the call created, so a caller can scope a search to a child
      // repository without first listing the registry.
      registered,
      discovered: { projects: dryRun.projects, files: dryRun.files, skipped: dryRun.skipped },
    };
  }

  private async _handleSync(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let projectId: string | undefined;
    const raw = await readBody(req).catch(() => null);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { projectId?: string };
        if (typeof parsed.projectId === "string" && parsed.projectId.length > 0) {
          projectId = parsed.projectId;
        }
      } catch {
        /* an unparseable body is a drain-everything request */
      }
    }

    if (!this.ingestionQueue) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, flushedFiles: 0, pendingFiles: 0, failedFiles: [] }));
      return;
    }

    const timeoutMs = this.config.ingestion?.syncTimeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
    const queue = this.ingestionQueue;
    const failedBefore = this._failed.size;

    try {
      // ADR-019: /sync is a drain barrier, so `prag sync && prag search` works.
      // Bounded, because a wedged worker must not wedge the caller too — the
      // worker's own job timeout eventually unwedges it (issue:worker-pool-…).
      const deadline = Date.now() + timeoutMs;
      // A fresh registration's initial scan may still be enumerating; draining
      // before it has queued anything would report a false "drained".
      const scan = queue.scanComplete(projectId);
      if (scan) await withDeadline(scan, deadline, "initial scan");
      let flushed = 0;
      const flush = queue.flushAll(projectId).then((n) => { flushed = n; });
      await withDeadline(flush, deadline, "flush");
      await withDeadline(this.awaitInflight(), deadline, "write");

      // After every write has landed: the one moment a pointer can be judged
      // against the whole tree rather than against one racing event.
      const reconciledPointers = await this._reconcileBranchPointers(projectId);

      const failed = [...this._failed];
      this._failed.clear();
      const pending = queue.pendingCount();

      res.writeHead(pending === 0 ? 200 : 202, {
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify({
        ok: pending === 0,
        flushedFiles: flushed,
        reconciledPointers,
        pendingFiles: pending,
        failedFiles: failed,
        hadNewFailures: failed.length > failedBefore,
      }));
    } catch (err) {
      if (err instanceof SyncTimeoutError) {
        // Named in the spec as 504/SYNC_TIMEOUT (storage-schema.md:423, ADR-019):
        // name what is outstanding rather than hang or pretend success.
        this.sendError(
          res,
          504,
          "SYNC_TIMEOUT",
          `${err.phase} did not finish within ${timeoutMs}ms`,
          "Re-run `prag sync`, or raise ingestion.syncTimeoutMs / PRAG_SYNC_TIMEOUT_MS " +
            "if a full drain legitimately takes longer on this corpus.",
          {
            timeoutMs,
            pendingFiles: queue.pendingCount(),
            pendingUris: queue.pendingUris(projectId).slice(0, 20),
          },
        );
        return;
      }
      this.sendInternal(res, "SYNC_FAILED", "the sync could not be completed", err);
    }
  }

  private async _handleGetGrants(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.db) {
      this.sendError(res, 503, "SERVICE_UNAVAILABLE", "the index is not open",
        "Start the daemon with `prag daemon start` and retry.");
      return;
    }

    try {
      const rows = await this.db.table("grants").query().limit(1000).toArray();
      const grants = (rows as Array<{ pattern: string; action: string; reason: string | null }>).map((r) => ({
        pattern: r.pattern,
        action: r.action,
        reason: r.reason ?? undefined,
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(grants));
    } catch {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("[]");
    }
  }

  private async _handlePostGrants(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    let opts: { pattern: string; action: string; reason?: string };
    try {
      opts = JSON.parse(body);
    } catch {
      this.sendError(res, 400, "INVALID_REQUEST", "request body is not valid JSON",
        "Send a JSON object with Content-Type: application/json");
      return;
    }

    if (!opts.pattern || !opts.action) {
      this.sendError(res, 400, "INVALID_REQUEST", "both 'pattern' and 'action' are required");
      return;
    }

    let outcome: Record<string, unknown>;
    try {
      outcome = await this.applyGrant(opts.pattern, opts.action, opts.reason);
    } catch (err) {
      if (err instanceof DaemonFailure) return this.sendFailure(res, err);
      return this.sendInternal(res, "INTERNAL", "could not apply the grant", err);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(outcome));
  }

  /**
   * Write a grant and do what a deny implies immediately: drop the covered files
   * from search and stop watching a root that lies inside it. Shared with the MCP
   * `deny_uri` tool so an agent and a human cannot get different guarantees.
   */
  async applyGrant(
    pattern: string,
    action: string,
    reason?: string,
  ): Promise<Record<string, unknown>> {
    if (action !== "allow" && action !== "deny") {
      throw new DaemonFailure(
        "INVALID_REQUEST",
        `action must be 'allow' or 'deny', got '${action}'`,
      );
    }
    if (!this.db) {
      throw new DaemonFailure(
        "SERVICE_UNAVAILABLE",
        "the index is not open",
        "Start the daemon with `prag daemon start` and retry.",
      );
    }

    await upsertGrants(this.db.table("grants"), [{
      pattern,
      action: action as "allow" | "deny",
      reason: reason ?? "cli_grant",
      createdAt: new Date(),
    }]);
    // A deny must stop the next file event, not the next restart (ADR-009 §4).
    this.invalidateGrantCache();

    let unwatched: string | null = null;
    let purged = 0;
    if (action === "deny") {
      // Report what is being taken out of search rather than silently dropping
      // rows; pool rows are shared and stay for --gc-chunks.
      purged = (await this.purgeDenied(pattern)).length;
      unwatched = this._unwatchUnder(pattern);
    }

    return { pattern, action, purgedFiles: purged, unwatched };
  }

  /**
   * Stop the watcher for any registered project whose root lies inside `pattern`,
   * so a denied directory stops producing events instead of being filtered per
   * file forever. Returns the project id, since at most one root can contain a
   * given path.
   */
  private _unwatchUnder(pattern: string): string | null {
    const dir = grantPatternToPath(pattern);
    for (const [projectId, root] of this.ingestionQueue?.registeredRoots() ?? []) {
      if (root === dir || root.startsWith(dir.endsWith("/") ? dir : dir + "/")) {
        this.ingestionQueue?.unregisterProject(projectId);
        return projectId;
      }
    }
    return null;
  }

  private async _handleEvaluateGrants(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    let opts: { uri: string };
    try {
      opts = JSON.parse(body);
    } catch {
      this.sendError(res, 400, "INVALID_REQUEST", "request body is not valid JSON",
        "Send a JSON object with Content-Type: application/json");
      return;
    }

    if (!opts.uri) {
      this.sendError(res, 400, "INVALID_REQUEST", "'uri' is required");
      return;
    }

    const grants = await this.db!.table("grants").query().toArray();
    const evaluation = evaluateUriGrants(opts.uri, grants as any[]);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(evaluation));
  }

  private async _handleDeleteGrants(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    let opts: { pattern: string };
    try {
      opts = JSON.parse(body);
    } catch {
      this.sendError(res, 400, "INVALID_REQUEST", "request body is not valid JSON",
        "Send a JSON object with Content-Type: application/json");
      return;
    }

    if (!opts.pattern) {
      this.sendError(res, 400, "INVALID_REQUEST", "'pattern' is required");
      return;
    }

    if (this.db) {
      const escaped = opts.pattern.replace(/'/g, "''");
      await this.db.table("grants").delete(`pattern = '${escaped}'`);
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ removed: opts.pattern }));
  }

  private async _handlePrune(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req).catch(() => null);
    let gcChunks = false;
    if (body) {
      try {
        gcChunks = Boolean((JSON.parse(body) as { gcChunks?: boolean }).gcChunks);
      } catch {
        /* treat an unparseable body as a plain prune */
      }
    }
    let outcome: Record<string, unknown>;
    try {
      outcome = await this.prune(gcChunks);
    } catch (err) {
      if (err instanceof DaemonFailure) return this.sendFailure(res, err);
      return this.sendInternal(res, "INTERNAL", "prune failed", err);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(outcome));
  }

  /**
   * `prag prune` and the MCP `prune_index` tool. A plain prune only prunes the
   * lightweight pointer tables; reclaiming pool rows is the explicit opt-in sweep
   * (ADR-017), because `chunks_pool` is content-addressed and shared with every
   * other project and branch that ever held the same text.
   */
  async prune(gcChunks = false): Promise<Record<string, unknown>> {
    if (!this.db) {
      throw new DaemonFailure(
        "SERVICE_UNAVAILABLE",
        "the index is not open",
        "Start the daemon with `prag daemon start` and retry.",
      );
    }

    // Dedup is a check-then-act sequence: an ingest that reads chunks_pool and
    // then writes its chunk_mapping pointer would have the chunk deleted in
    // between, leaving a dangling pointer. Hence the drain + pause (ADR-017).
    if (gcChunks && this.ingestionQueue) {
      await this.ingestionQueue.flushAll();
      this.ingestionQueue.pause();
    }

    let prunedFiles = 0;
    let purgedChunks = 0;

    try {
      // 1. Find stale file_mapping entries (file no longer exists)
      const files = await this.db.table("file_mapping").query().limit(10000).toArray() as Array<{ fileVersionId: string; uri: string }>;

      for (const file of files) {
        const filePath = file.uri.startsWith("file://")
          ? file.uri.slice(7)
          : file.uri;
        try {
          statSync(filePath);
        } catch {
          // Pool rows are content-addressed and shared, so only the pointer rows
          // go here; the whole-pool sweep below is what reclaims them
          // (issue:unlink-prune-deletes-shared-pool-rows).
          await this.db.table("chunk_mapping").delete(`fileVersionId = '${file.fileVersionId.replace(/'/g, "''")}'`);
          await this.db.table("file_mapping").delete(`fileVersionId = '${file.fileVersionId.replace(/'/g, "''")}'`);
          prunedFiles++;
        }
      }

      // 2. Drop pointers for branches that no longer exist in git, then the file
      //    versions nothing points at any more. Both are default prune work
      //    (ADR-017); only the pool sweep is opt-in.
      const prunedBranches = await this._pruneBranchPointers();
      const prunedVersions = await this._pruneUnreferencedVersions();

      if (gcChunks) purgedChunks += await this.gcUnreferencedChunks();

      return { prunedFiles, purgedChunks, prunedBranches, prunedVersions, gcChunks };
    } finally {
      if (gcChunks && this.ingestionQueue) this.ingestionQueue.resume();
    }
  }

  /**
   * What an agent needs to know about one workspace: is it indexed, on which
   * branch, and how much of it is in the index. `prag status` and the MCP
   * `get_indexing_status` tool both read this.
   *
   * `uri` is required for MCP callers — the in-daemon server has no working
   * directory of its own to resolve a relative path against.
   */
  async statusFor(uri: string): Promise<Record<string, unknown>> {
    if (!this.db) {
      throw new DaemonFailure(
        "SERVICE_UNAVAILABLE",
        "the index is not open",
        "Start the daemon with `prag daemon start` and retry.",
      );
    }
    if (!uri) {
      throw new DaemonFailure(
        "INVALID_REQUEST",
        "'uri' is required",
        "Pass the workspace URI to inspect; the daemon has no working directory of its own.",
      );
    }

    const rootUri = uri.startsWith("file://") ? uri : pathToFileURL(resolve(uri)).href;
    const projects = (await this.db.table("projects").query().limit(1000).toArray()) as Array<{
      projectId: string;
      rootUri: string;
      status: string;
      isGit: boolean;
    }>;
    const wanted = rootUri.replace(/\/$/, "");
    const project = projects.find(
      (p) => String(p.rootUri).replace(/\/$/, "") === wanted,
    );
    if (!project) {
      throw new DaemonFailure(
        "PROJECT_NOT_FOUND",
        `no registered project is rooted at ${rootUri}`,
        "Register it with `prag watch <uri>`, or list what is known with `prag projects`.",
      );
    }

    const root = this.ingestionQueue
      ?.registeredRoots()
      .find(([id]) => id === project.projectId)?.[1];
    // Read HEAD rather than trusting projects.isGit: a worktree's `.git` is a
    // file, and a repository created after registration would still read false.
    const branch = root ? resolveBranch(root) : DEFAULT_BRANCH;

    const files = (await this.db
      .table("file_mapping")
      .query()
      .filter(`projectId = '${project.projectId.replace(/'/g, "''")}'`)
      .limit(100000)
      .toArray()) as Array<{ fileVersionId: string }>;
    const versions = new Set(files.map((f) => String(f.fileVersionId)));
    const chunkHashes = new Set<string>();
    if (versions.size > 0) {
      const chunks = (await this.db
        .table("chunk_mapping")
        .query()
        .limit(100000)
        .toArray()) as Array<{ fileVersionId: string; chunkHash: string }>;
      for (const c of chunks) {
        if (versions.has(String(c.fileVersionId))) chunkHashes.add(String(c.chunkHash));
      }
    }

    return {
      projectId: project.projectId,
      rootUri: project.rootUri,
      status: String(project.status),
      branch,
      indexed: { files: files.length, fileVersions: versions.size, chunks: chunkHashes.size },
      watched: root !== undefined,
      ingestion: this.ingestionQueue?.stats() ?? null,
    };
  }

  /**
   * Drop current-branch pointers whose file is gone, after a drain.
   *
   * An unlink cannot be trusted to be the last word. Chokidar reports the deletion
   * while the write chain for the file's *earlier* add is still running, and
   * `_handleUnlink` has to name a branch to delete from — so it reads `.git/HEAD`,
   * which by then names whatever the user switched to. Observed in
   * packages/daemon/test/branch-awareness.test.ts: `rm tempo.ts` on `feature` deleted
   * `branch_mapping(branch='main', uri=tempo.ts)` — a row that did not exist — and
   * left `feature`'s pointer behind permanently. Serialising the writes per path does
   * not help: HEAD, not the write order, was what it got wrong.
   *
   * /sync is the documented reconciliation barrier
   * (design/features/background-worker-queue.md:36), so this judges each project's
   * pointers against the tree as it stands once every write has landed. Only the
   * **current** branch's pointers are eligible: git-branch-awareness.md:37 promises
   * "Other branches continue pointing to their respective historical fileVersionId",
   * so a file missing from this checkout is normal for a branch not checked out, and
   * branches that no longer exist are prune's business (ADR-017, explicit calls only).
   * One stat per pointer, and nothing else is touched.
   *
   * Self-healing: a pointer dropped during a partial checkout comes back on the next
   * drain, because `git checkout` rewrites mtimes and `_reconcile` queues anything
   * modified since the last walk.
   */
  private async _reconcileBranchPointers(projectId?: string): Promise<number> {
    if (!this.db) return 0;
    const esc = (v: string): string => v.replace(/'/g, "''");

    const roots = this.ingestionQueue?.registeredRoots() ?? [];
    let removed = 0;

    for (const [id, root] of roots) {
      if (projectId && id !== projectId) continue;
      // ADR-023: a paused project's index is frozen. Reconciling it would drop
      // pointers for files a branch switch removed, and resume is meant to find
      // the index as it was.
      if (await this._projectPaused(id)) continue;
      const branch = resolveBranch(root);
      // $default has no branch identity to reconcile against: a non-git workspace
      // cannot say whether a missing file was deleted or never existed, and
      // `prag prune` is the documented way to drop an indexed-but-deleted file there.
      if (branch === DEFAULT_BRANCH) continue;

      const pointers = (await this.db.table("branch_mapping").query()
        .filter(`projectId = '${esc(id)}' AND branch = '${esc(branch)}'`)
        .limit(10000)
        .toArray()) as Array<{ uri: string; fileVersionId: string }>;

      for (const p of pointers) {
        const path = p.uri.startsWith("file://") ? p.uri.slice(7) : p.uri;
        try {
          statSync(path);
          continue; // still on this branch's tree
        } catch {
          /* gone: the pointer cannot stand */
        }
        await this.db.table("branch_mapping").delete(
          `projectId = '${esc(id)}' AND branch = '${esc(branch)}' AND uri = '${esc(p.uri)}'`,
        );
        removed++;
        // The version may still be held by another branch, which is the whole point
        // of checking rather than deleting (issue:unlink-prune-deletes-shared-pool-rows).
        await this._retireVersionIfUnreferenced(p.fileVersionId);
      }
    }
    return removed;
  }

  /**
   * Delete `branch_mapping` rows for branches git no longer has, which is what
   * `git branch -d` leaves behind. `$default` is never a git branch, so it is left
   * alone; a non-git project lists no branches and therefore loses nothing.
   * Returns the number of branch pointers removed.
   */
  private async _pruneBranchPointers(): Promise<number> {
    if (!this.db) return 0;
    const rows = (await this.db
      .table("branch_mapping")
      .query()
      .limit(10000)
      .toArray()) as Array<{ projectId: string; branch: string }>;

    // null = watched project whose root is unknown: branch list unknowable.
    const alive = new Map<string, Set<string> | null>();
    let removed = 0;
    for (const row of rows) {
      if (row.branch === DEFAULT_BRANCH) continue;
      let branches: Set<string> | null | undefined = alive.get(row.projectId);
      if (branches === undefined) {
        const root = this.ingestionQueue
          ?.registeredRoots()
          .find(([id]) => id === row.projectId)?.[1];
        // An unwatched project's branch list is unknowable here; dropping its
        // pointers would delete the index on a prune, so keep them.
        branches = root ? new Set(listGitBranches(root)) : null;
        alive.set(row.projectId, branches);
      }
      if (branches && !branches.has(row.branch)) {
        await this.db.table("branch_mapping").delete(
          `projectId = '${row.projectId.replace(/'/g, "''")}' AND branch = '${row.branch.replace(/'/g, "''")}'`,
        );
        removed++;
      }
    }
    return removed;
  }

  /**
   * Purge `file_mapping` + `chunk_mapping` rows no branch pointer references — the
   * default orphan cleanup (ADR-017). Pool rows survive: they are shared by content
   * address and only `--gc-chunks` reclaims them.
   */
  private async _pruneUnreferencedVersions(): Promise<number> {
    if (!this.db) return 0;
    const pointers = (await this.db
      .table("branch_mapping")
      .query()
      .limit(100000)
      .toArray()) as Array<{ fileVersionId: string; projectId: string }>;
    const referenced = new Set(pointers.map((p) => String(p.fileVersionId)));
    // Tracked per *project*, not globally: a project indexed before branch
    // tracking existed has no pointers, and a second project that does have them
    // must not make the first one's files look orphaned (the same upgrade rule
    // hybridSearch applies).
    const trackedProjects = new Set(pointers.map((p) => String(p.projectId)));
    if (trackedProjects.size === 0) return 0;

    const files = (await this.db
      .table("file_mapping")
      .query()
      .limit(100000)
      .toArray()) as Array<{ fileVersionId: string; projectId: string }>;

    let removed = 0;
    for (const file of files) {
      if (!trackedProjects.has(String(file.projectId))) continue;
      if (referenced.has(String(file.fileVersionId))) continue;
      const esc = String(file.fileVersionId).replace(/'/g, "''");
      await this.db.table("chunk_mapping").delete(`fileVersionId = '${esc}'`);
      await this.db.table("file_mapping").delete(`fileVersionId = '${esc}'`);
      removed++;
    }
    return removed;
  }

  /**
   * The explicit GC sweep (ADR-017): delete every pool row no chunk_mapping row
   * references, then compact. Returns the number of reclaimed chunk hashes.
   */
  private async gcUnreferencedChunks(): Promise<number> {
    if (!this.db) return 0;

    const pool = await this.db.table("chunks_pool").query().limit(100000).toArray() as Array<{ chunkHash: string }>;
    if (pool.length === 0) return 0;

    const referenced = new Set<string>();
    for (const cm of await this.db.table("chunk_mapping").query().limit(100000).toArray() as Array<{ chunkHash: string }>) {
      referenced.add(cm.chunkHash);
    }

    const orphans = pool.map((p) => p.chunkHash).filter((h) => !referenced.has(h));
    if (orphans.length === 0) return 0;

    const inList = orphans.map((h) => `'${h.replace(/'/g, "''")}'`).join(", ");
    await this.db.table("chunks_pool").delete(`chunkHash IN (${inList})`);
    await this.db.table("vector_pool").delete(`chunkHash IN (${inList})`);

    // Compact both tables so the space is actually returned (ADR-017).
    await this.db.table("chunks_pool").optimize();
    await this.db.table("vector_pool").optimize();
    return orphans.length;
  }

  /**
   * ADR-015 §3: re-embedding is a drop-and-requeue rebuild, never a vector swap.
   *
   * Drops every content-derived table, pins the new model, then seeds the normal
   * ingestion queue with a full rescan of each registered project and returns at
   * once. The rebuild proceeds in the background at the queue's usual rate, so
   * there is no long-lived request to time out; progress is read from
   * `prag status` (ADR-015 §4).
   *
   * The previous implementation re-embedded `chunks_pool` in place. That could
   * not absorb a dimension change, reused vectorised-unit boundaries measured
   * with the old tokenizer (ADR-014), and ignored `{ model }` outright, so
   * `prag reembed --model X` silently re-embedded with the current model.
   */
  private async _handleReembed(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rebuild = this._options.rebuild;
    if (!rebuild) {
      // Not SERVICE_UNAVAILABLE: the daemon is fine, it was just constructed
      // without the hook (an embedded test daemon). Saying "no embedding
      // provider, run prag reembed" here was circular advice to the one caller
      // already running reembed.
      this.sendError(res, 503, "SERVICE_UNAVAILABLE",
        "this daemon was started without a rebuild hook",
        "Start the daemon with `prag daemon start` rather than embedding it directly.");
      return;
    }

    let model: string | undefined;
    const raw = await readBody(req).catch(() => null);
    if (raw && raw.trim() !== "") {
      let parsed: { model?: unknown };
      try {
        parsed = JSON.parse(raw) as { model?: unknown };
      } catch {
        this.sendError(res, 400, "INVALID_REQUEST", "the request body is not valid JSON");
        return;
      }
      if (parsed.model !== undefined && parsed.model !== null) {
        if (typeof parsed.model !== "string" || parsed.model.trim() === "") {
          this.sendError(res, 400, "INVALID_REQUEST", "'model' must be a non-empty string");
          return;
        }
        model = parsed.model.trim();
      }
    }

    // Two rebuilds at once would race on the same tables, and the second would
    // report success over a half-dropped index.
    if (this._reembedding) {
      this.sendError(res, 409, "REEMBED_IN_PROGRESS",
        "a re-embedding rebuild is already running",
        "Wait for it to finish (`prag status` reports progress), then retry.");
      return;
    }
    this._reembedding = true;

    try {
      // The hook drops the content tables, writes the sidecar and reopens the
      // database at the new dimension. `grants` and `projects` survive it, which
      // is what lets the requeue below know what to rescan.
      const rebuilt = await rebuild(model);

      const previous = this.db;
      this.db = rebuilt.schema;
      this.embedder = rebuilt.provider;
      this._options = { ...this._options, maxVectorUnitTokens: rebuilt.maxVectorUnitTokens };
      // The index now matches the configured model, so the daemon leaves
      // degraded mode and serves every route again (ADR-015 §2).
      this._mismatch = null;
      this.mcpHandler = new McpHandler(rebuilt.schema, rebuilt.provider, {
        watchUri: (o) => this.watchUri(o),
        applyGrant: (pattern, action, reason) => this.applyGrant(pattern, action, reason),
        prune: (gcChunks) => this.prune(gcChunks),
        statusFor: (uri) => this.statusFor(uri),
        currentBranch: (projectId) => this.currentBranchFor(projectId),
      });
      // Only after the swap: closing the old handles first would leave the
      // daemon with no database at all if the rebuild threw.
      if (previous && previous !== rebuilt.schema) await previous.close();

      const projects = (await this.db.table("projects").query().limit(1000).toArray()) as Array<{
        projectId: string;
        rootUri: string;
        name: string;
        isGit: boolean;
        defaultCooldownSeconds: number;
        registeredAt: Date;
        lastSyncedAt: Date | null;
      }>;

      // 'indexing' before the queue is seeded, so a status read between the two
      // never shows 'active' over an index that was just emptied.
      if (projects.length > 0) {
        await upsertProjects(this.db.table("projects"), projects.map((p) => ({
          ...p,
          status: "indexing",
          lastSyncedAt: null,
        })));
      }

      let requeued = 0;
      for (const project of projects) {
        const dirPath = fileURLToPath(project.rootUri);
        if (!existsSync(dirPath)) {
          // A registered root that has since been deleted must not abort the
          // rebuild of every other project.
          console.error(`[prag] reembed: skipping ${project.projectId}, ${dirPath} is gone`);
          continue;
        }
        // Re-registering with chokidar's ignoreInitial: false is the full
        // rescan: every file is re-read, re-parsed and re-embedded from source.
        this.ingestionQueue?.unregisterProject(project.projectId);
        this.ingestionQueue?.registerProject(
          project.projectId,
          dirPath,
          project.defaultCooldownSeconds * 1000,
        );
        requeued++;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        requeued,
        model: rebuilt.provider.model,
        dim: rebuilt.provider.dim,
      }));
    } catch (err) {
      // A failed rebuild may have dropped tables already. Reporting 200 with a
      // zeroed counter hid exactly that, so the envelope is mandatory here.
      this.sendInternal(res, "INTERNAL", "the re-embedding rebuild failed", err);
    } finally {
      this._reembedding = false;
    }
  }

  /**
   * How a chunk is cut into vector units (ADR-014). Only ingestion uses this
   * now: a re-embed rebuilds from source through this same path rather than
   * reusing boundaries that the previous model's tokenizer measured.
   */
  private _unitSplit(embedder: EmbeddingProvider): {
    tokenizer: Tokenizer;
    maxTokens: number;
    overlap: number;
  } {
    return {
      tokenizer: embedder.tokenizer ?? approximateTokenizer(),
      maxTokens:
        this._options.maxVectorUnitTokens ??
        Math.min(DEFAULT_MAX_VECTOR_UNIT_TOKENS, embedder.maxSeqLength),
      overlap:
        this._options.vectorUnitOverlapTokens ?? DEFAULT_VECTOR_UNIT_OVERLAP_TOKENS,
    };
  }

  /**
   * Hold a project whose growth breaker tripped (ADR-023).
   *
   * Pause, not refuse: the files stay on disk, nothing is dropped from the
   * index, and `prag resume` re-walks the tree -- so a user who meant to add
   * the content gets it with one command, and one who did not has time to
   * `prag deny` the directory first. Refusing the files instead would leave
   * the project silently under-indexed, which ADR-023 forbids.
   *
   * The whole project is held rather than the offending subtree because the
   * subtree cannot be identified reliably, only guessed at; `topDirectory` is
   * that guess, offered in the message rather than acted on.
   */
  private async _holdProject(breach: GrowthBreach): Promise<void> {
    const where = breach.topDirectory ? ` Most of it is under "${breach.topDirectory}".` : "";
    const what = breach.limit === "files"
      ? `${breach.files.toLocaleString()} files`
      : `${(breach.bytes / 1024 / 1024).toFixed(0)}MB`;
    console.error(
      `[prag] project ${breach.projectId} is on hold: ${what} arrived within ` +
      `${Math.round(breach.windowMs / 1000)}s, which is over the ingestion growth limit.${where} ` +
      "Nothing has been dropped. Run `prag resume " + breach.projectId + "` to index it, " +
      "or `prag deny <path>` first to exclude it.",
    );
    try {
      await this._setProjectStatus(breach.projectId, "paused");
    } catch (err) {
      // The breaker has already stopped admitting for this project in memory,
      // so a failed write means the hold is not durable across a restart --
      // worth saying, not worth crashing over.
      console.error(`[prag] could not persist the hold on ${breach.projectId}:`, err);
    }
  }

  /** Write a project's status and drop the cache the admission gate reads. */
  private async _setProjectStatus(projectId: string, status: string): Promise<void> {
    if (this.db) {
      const escaped = projectId.replace(/'/g, "''");
      await this.db.table("projects").update({
        values: { status },
        where: `projectId = '${escaped}'`,
      });
    }
    // The status is read per file through a short cache; drop it so the next
    // event sees the change rather than the next second's (ADR-023).
    this._pausedCache = null;
  }

  private async _handlePauseResume(req: IncomingMessage, res: ServerResponse, newStatus: string): Promise<void> {
    const body = await readBody(req);
    let opts: { projectId: string };
    try {
      opts = JSON.parse(body);
    } catch {
      this.sendError(res, 400, "INVALID_REQUEST", "request body is not valid JSON",
        "Send a JSON object with Content-Type: application/json");
      return;
    }

    if (!opts.projectId) {
      this.sendError(res, 400, "INVALID_REQUEST", "'projectId' is required");
      return;
    }

    await this._setProjectStatus(opts.projectId, newStatus);
    if (newStatus === "active") {
      // Files written while paused were dropped at admission, and the
      // incremental mtime walk now considers them seen: force a full re-walk.
      // Unchanged files short-circuit on content hash, so this re-reads rather
      // than re-embeds (ADR-023: resume must not re-index current files).
      this.ingestionQueue?.rescan(opts.projectId);
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ projectId: opts.projectId, status: newStatus }));
  }

  private _handleShutdown(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200);
    res.end("Shutting down\n");
    setImmediate(() => {
      // Awaited: the previous version called stop() without awaiting and exited
      // in the same tick, truncating the drain.
      this.stop()
        .catch((err) => console.error("[prag] shutdown error:", err))
        .finally(() => {
          if (!this._noExit) process.exit(0);
        });
    });
  }
}

// ── Body reader ──────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
