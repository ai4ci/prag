// @prag/daemon — Local HTTP daemon for prag
//
// Binds to 127.0.0.1, authenticates via PRAG_API_KEY, and exposes
// endpoints: GET /health, POST /search, GET /projects, POST /projects,
// POST /sync, POST /shutdown, and GET/POST /mcp for the MCP SSE interface.

import {
  createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { statSync } from "node:fs";
import { basename, join } from "node:path";
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
} from "@prag/core";

import { McpHandler } from "./mcp-server.js";
import { assertProjectRegistered } from "./project-lookup.js";
import { WorkerPool } from "./worker-pool.js";
import { IngestionQueue, DEFAULT_COOLDOWN_MS } from "./ingestion-queue.js";
import { type ProcessResult } from "./worker-pool.js";

// ── Config ────────────────────────────────────────────────────────────

const DEFAULT_PORT = 7724; // used by main.ts via loadConfig()
export { DEFAULT_PORT };
export { API_VERSION };

export const DAEMON_VERSION = "0.1.0";

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
  };
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
    if (db && embedder) this.mcpHandler = new McpHandler(db, embedder);

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
        },
      );
    }

    this.startTime = Date.now();

    return new Promise((resolve) => {
      this.server = createServer((req, res) => this._handle(req, res));
      this.server.listen(this.config.port, "127.0.0.1", () => {
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

  /** Register a project directory for file watching. */
  registerProject(projectId: string, dirPath: string): void {
    if (!this.ingestionQueue) {
      throw new Error("Ingestion not enabled (set ingestion.poolSize > 0)");
    }
    this.ingestionQueue.registerProject(projectId, dirPath);
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
      .limit(1)
      .toArray() as Array<{ fileVersionId: string }>;

    if (existing.length === 0) return;
    const fileVersionId = existing[0].fileVersionId;

    await this.db.table("chunk_mapping").delete(`fileVersionId = '${fileVersionId}'`);
    await fmTable.delete(`fileVersionId = '${fileVersionId}'`);
    // No pool delete here. The hash may be referenced by any other file,
    // project or branch, and reclamation is the explicit --gc-chunks sweep's
    // job (ADR-017, issue:unlink-prune-deletes-shared-pool-rows).
  }

  private async _ingestFile(result: ProcessResult): Promise<void> {
    if (!this.db || !this.embedder) return;

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

    if (current && current.contentHash === contentHash) {
      // Refresh the lease only; the index is already correct.
      await fmTable.update({
        values: { validUntil: this.cooldownExpiry() },
        where: `fileVersionId = '${current.fileVersionId as string}'`,
      });
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

    const fileVersionId = contentHash;
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
      validUntil: this.cooldownExpiry(),
      contentHash,
      language: result.language,
    }]);

    // The path moved to new content: drop the superseded version's mapping rows
    // so a file is not returned twice. Pool rows are left for --gc-chunks since
    // they are shared by content address (issue:unlink-prune-deletes-shared-pool-rows).
    if (current && current.fileVersionId !== fileVersionId) {
      const oldId = String(current.fileVersionId);
      await this.db.table("chunk_mapping").delete(`fileVersionId = '${oldId}'`);
      await fmTable.delete(`fileVersionId = '${oldId}'`);
    }

    await upsertChunkMapping(this.db.table("chunk_mapping"), cmRows);
    await upsertChunksPool(this.db.table("chunks_pool"), cpRows);
    await upsertVectorPool(this.db.table("vector_pool"), vpRows);
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

    if (!queryText) {
      this.sendError(res, 400, "INVALID_REQUEST", "'query' field is required");
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
        { projectId, mode },
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
      this.sendError(res, 400, "INVALID_REQUEST", "both '$2' and '$3' are required");
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
    if (!this.db) {
      this.sendError(res, 503, "SERVICE_UNAVAILABLE", "the index is not open",
        "Start the daemon with `prag daemon start` and retry.");
      return;
    }

    const body = await readBody(req).catch(() => null);
    let opts: { uri?: string; projectId?: string; confirm?: boolean } = {};
    if (body) {
      try {
        opts = JSON.parse(body);
      } catch {
        /* treated as a missing uri below */
      }
    }

    const rootUri = opts.uri;
    if (!rootUri) {
      this.sendError(res, 400, "INVALID_REQUEST", "'uri' is required");
      return;
    }
    if (!rootUri.startsWith("file://")) {
      this.sendError(
        res,
        503,
        "CRAWL_BACKEND_REQUIRED",
        `no web fetch backend is configured to watch ${rootUri}`,
        "Set web.backend in config.json or PRAG_WEB_BACKEND, or watch a file:// URI",
      );
      return;
    }

    const dirPath = fileURLToPath(rootUri);
    try {
      statSync(dirPath);
    } catch {
      this.sendError(res, 400, "INVALID_REQUEST", `directory '${dirPath}' does not exist`);
      return;
    }

    const dryRun = await discoveryDryRun(dirPath, await this._grantRows(), {
      maxFileBytes: this.config.ingestion?.maxFileBytes,
      threshold: this.config.ingestion?.watchConfirmThreshold,
    });

    if (dryRun.exceedsThreshold && !opts.confirm) {
      this.sendError(
        res,
        409,
        "WATCH_LIMIT_EXCEEDED",
        `watching ${dirPath} would register ${dryRun.projects} projects / ${dryRun.files} files`,
        "Re-send with confirm: true (CLI: --yes) to proceed",
        {
          projects: dryRun.projects,
          files: dryRun.files,
          threshold: dryRun.threshold ?? DEFAULT_WATCH_CONFIRM_THRESHOLD,
        },
      );
      return;
    }

    await upsertGrants(this.db.table("grants"), [{
      pattern: pathToGrantPattern(dirPath, "allow"),
      action: "allow",
      reason: "watch_root",
      createdAt: new Date(),
    }]);
    this.invalidateGrantCache();

    const projectId = opts.projectId ?? dirPath;
    const isGit = statSync(join(dirPath, ".git"), { throwIfNoEntry: false })?.isDirectory() ?? false;
    await upsertProjects(this.db.table("projects"), [{
      projectId,
      rootUri: pathToFileURL(dirPath).href,
      name: basename(dirPath),
      isGit,
      defaultCooldownSeconds: Math.round(
        (this.config.ingestion?.cooldownMs ?? DEFAULT_COOLDOWN_MS) / 1000,
      ),
      status: "active",
      registeredAt: new Date(),
      lastSyncedAt: null,
    }]);

    try {
      this.registerProject(projectId, dirPath);
    } catch (err) {
      this.sendInternal(res, "INTERNAL", "could not watch the project", err);
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      projectId,
      rootUri: pathToFileURL(dirPath).href,
      status: "active",
      discovered: { projects: dryRun.projects, files: dryRun.files, skipped: dryRun.skipped },
    }));
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

      const failed = [...this._failed];
      this._failed.clear();
      const pending = queue.pendingCount();

      res.writeHead(pending === 0 ? 200 : 202, {
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify({
        ok: pending === 0,
        flushedFiles: flushed,
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
      this.sendError(res, 400, "INVALID_REQUEST", "both '$2' and '$3' are required");
      return;
    }

    if (this.db) {
      await upsertGrants(this.db.table("grants"), [{
        pattern: opts.pattern,
        action: opts.action as "allow" | "deny",
        reason: opts.reason ?? "cli_grant",
        createdAt: new Date(),
      }]);
    }
    // A deny must stop the next file event, not the next restart (ADR-009 §4).
    this.invalidateGrantCache();

    let unwatched: string | null = null;
    let purged = 0;
    if (opts.action === "deny" && this.db) {
      // Report what is being taken out of search rather than silently dropping
      // rows; pool rows are shared and stay for --gc-chunks.
      purged = (await this.purgeDenied(opts.pattern)).length;
      unwatched = this._unwatchUnder(opts.pattern);
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      pattern: opts.pattern,
      action: opts.action,
      purgedFiles: purged,
      unwatched,
    }));
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
      this.sendError(res, 400, "INVALID_REQUEST", "'$2' is required");
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
      this.sendError(res, 400, "INVALID_REQUEST", "'$2' is required");
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
    if (!this.db) {
      this.sendError(res, 503, "SERVICE_UNAVAILABLE", "the index is not open",
        "Start the daemon with `prag daemon start` and retry.");
      return;
    }

    // `prag prune` only prunes the lightweight pointer tables; reclaiming pool
    // rows is the explicit `--gc-chunks` sweep (ADR-017).
    const body = await readBody(req).catch(() => null);
    let gcChunks = false;
    if (body) {
      try {
        gcChunks = Boolean((JSON.parse(body) as { gcChunks?: boolean }).gcChunks);
      } catch {
        /* treat an unparseable body as a plain prune */
      }
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
          // File doesn't exist — prune its pointer rows. Pool rows are
          // content-addressed and shared with every other project and branch
          // that indexed the same text (issue:unlink-prune-deletes-shared-pool-
          // rows); the whole-pool sweep below is what reclaims them.
          await this.db.table("chunk_mapping").delete(`fileVersionId = '${file.fileVersionId.replace(/'/g, "''")}'`);
          await this.db.table("file_mapping").delete(`fileVersionId = '${file.fileVersionId.replace(/'/g, "''")}'`);

          // Pool rows are content-addressed and shared with every other project
          // and branch that indexed the same text (issue:unlink-prune-deletes-
          // shared-pool-rows); the whole-pool sweep below is what reclaims them.
          prunedFiles++;
        }
      }

      // 2. Remove orphaned branch_mapping entries (no files reference them)
      const branches = await this.db.table("branch_mapping").query().limit(10000).toArray() as Array<{ projectId: string; branch: string }>;
      let prunedBranches = 0;
      for (const branch of branches) {
        const refs = await this.db.table("file_mapping")
          .query()
          .where(`projectId = '${branch.projectId.replace(/'/g, "''")}'`)
          .limit(1)
          .toArray();
        if (refs.length === 0) {
          await this.db.table("branch_mapping").delete(
            `projectId = '${branch.projectId.replace(/'/g, "''")}' AND branch = '${branch.branch.replace(/'/g, "''")}'`,
          );
          prunedBranches++;
        }
      }

      if (gcChunks) purgedChunks += await this.gcUnreferencedChunks();

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ prunedFiles, purgedChunks, prunedBranches, gcChunks }));
    } catch (err) {
      this.sendInternal(res, "INTERNAL", "prune failed", err);
    } finally {
      if (gcChunks && this.ingestionQueue) this.ingestionQueue.resume();
    }
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

  private async _handleReembed(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.db || !this.embedder) {
      this.sendError(res, 503, "SERVICE_UNAVAILABLE",
        "no embedding provider is available",
      "Start the daemon with a working PRAG_EMBEDDING_MODEL, or run `prag reembed`.");
      return;
    }

    // Two sweeps at once would interleave writes to vector_pool, and the second
    // would report success over a half-rewritten index.
    if (this._reembedding) {
      this.sendError(res, 409, "REEMBED_IN_PROGRESS",
        "a re-embedding sweep is already running",
        "Wait for it to finish (`prag status` reports progress), then retry.");
      return;
    }
    this._reembedding = true;

    let requeued = 0;

    try {
      const chunks = await this.db.table("chunks_pool")
        .query()
        .limit(10000)
        .toArray() as Array<{ chunkHash: string; text: string; scopeContext: string | null }>;

      if (chunks.length === 0) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ requeued: 0, total: 0 }));
        return;
      }

      // Units the sweep will not rewrite have to go (a chunk that now splits into
      // fewer windows), or a query can still hit a vector from the previous model.
      // Diffed up front and deleted only after the sweep succeeds: clearing the
      // pool first left the index with zero vectors whenever a later batch failed.
      const before = await this.db
        .table("vector_pool")
        .query()
        .select(["chunkHash", "unitIndex"])
        .limit(100000)
        .toArray() as Array<{ chunkHash: string; unitIndex: number }>;


      // Re-embed in batches. Rows are keyed by (chunkHash, unitIndex) and merged,
      // so the sweep never empties the pool: an earlier `delete("true")` here left
      // the index with zero vectors whenever a later batch failed.
      const batchSize = this._options.embeddingBatchSize ?? DEFAULT_EMBEDDING_BATCH;
      const { tokenizer, maxTokens, overlap } = this._unitSplit(this.embedder);
      const written: Array<{ chunkHash: string; unitIndex: number }> = [];
      for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        // One chunk is several vector units (ADR-014), so the sweep must split it
        // exactly as ingestion does. Writing unitIndex 0 only left every re-embedded
        // chunk searchable by its first window and silent for the rest.
        const texts: string[] = [];
        const rows: Array<{ chunkHash: string; unitIndex: number }> = [];
        for (const chunk of batch) {
          const units = splitVectorUnits(
            chunk.text,
            chunk.scopeContext ?? "",
            tokenizer,
            maxTokens,
            overlap,
          );
          units.forEach((_unit, unitIndex) => {
            texts.push(units.length === 1 ? chunk.text : units[unitIndex]!);
            rows.push({ chunkHash: chunk.chunkHash, unitIndex });
          });
        }
        const vectors = await this.embedder.embedBatch(texts);

        await upsertVectorPool(
          this.db.table("vector_pool"),
          rows.map((row, j) => ({ ...row, vector: vectors[j]! })),
        );
        requeued += batch.length;
        written.push(...rows);
      }

      const kept = new Set(written.map((r) => `${r.chunkHash}#${r.unitIndex}`));
      const stale = before.filter((r) => !kept.has(`${r.chunkHash}#${r.unitIndex}`));
      if (stale.length > 0) {
        // Keyed deletes rather than delete("true"): the surviving vectors are
        // never dropped, so the index stays searchable throughout.
        for (const row of stale) {
          await this.db
            .table("vector_pool")
            .delete(`chunkHash = '${row.chunkHash}' AND unitIndex = ${row.unitIndex}`);
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ requeued, total: chunks.length, staleRemoved: stale.length }));
    } catch (err) {
      // A partial sweep must be reported: answering 200 with zeros hid the fact
      // that the index had just been rewritten by an interrupted sweep.
      this.sendInternal(res, "INTERNAL", "the re-embedding sweep failed", err);
    } finally {
      this._reembedding = false;
    }
  }

  /**
   * How a chunk is cut into vector units. Ingestion and reembed must agree
   * exactly, or a sweep silently changes which part of a chunk is findable.
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
      this.sendError(res, 400, "INVALID_REQUEST", "'$2' is required");
      return;
    }

    if (this.db) {
      const escaped = opts.projectId.replace(/'/g, "''");
      const tbl = this.db.table("projects");
      await tbl.update({
        values: { status: newStatus },
        where: `projectId = '${escaped}'`,
      });
    }
    // The status is read per file through a short cache; drop it so the next
    // event sees the change rather than the next second's (ADR-023).
    this._pausedCache = null;
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
