// @prag/daemon — Local HTTP daemon for prag
//
// Binds to 127.0.0.1, authenticates via PRAG_API_KEY, and exposes
// endpoints: GET /health, POST /search, GET /projects, POST /projects,
// POST /sync, POST /shutdown, and GET/POST /mcp for the MCP SSE interface.

import {
  createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { statSync } from "node:fs";

import {
  type LanceDbSchema,
  type EmbeddingProvider,
  type SearchResult,
  type SearchMode,
  resolvePragPaths,
  type PragPaths,
  hybridSearch,
  upsertGrants,
  upsertProjects,
  upsertFileMapping,
  upsertChunkMapping,
  upsertChunksPool,
  upsertVectorPool,
  evaluateUriGrants,
  approximateTokenizer,
  splitVectorUnits,
  DEFAULT_MAX_VECTOR_UNIT_TOKENS,
  DEFAULT_VECTOR_UNIT_OVERLAP_TOKENS,
  API_VERSION,
} from "@prag/core";

import { McpHandler } from "./mcp-server.js";
import { WorkerPool } from "./worker-pool.js";
import { IngestionQueue, DEFAULT_COOLDOWN_MS } from "./ingestion-queue.js";
import { type ProcessResult } from "./worker-pool.js";

// ── Config ────────────────────────────────────────────────────────────

const DEFAULT_PORT = 7724; // used by main.ts via loadConfig()
export { DEFAULT_PORT };
export { API_VERSION };

export const DAEMON_VERSION = "0.1.0";

/** Endpoints still served while the index has a model mismatch (ADR-015). */
export const MISMATCH_ALLOWED = new Set(["/health", "/reembed", "/shutdown"]);

/** Chunks per embedBatch call when the caller does not override it. */
const DEFAULT_EMBEDDING_BATCH = 32;

export interface DaemonConfig {
  port?: number;
  token?: string;
  paths?: PragPaths;
  ingestion?: {
    cooldownMs?: number;
    maxFileBytes?: number;
    poolSize?: number;
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
        await this.ingestionQueue.flushAll();
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

  /** Wait for ingestion writes currently in flight (one drain pass). */
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
    const tokenizer =
      this.embedder.tokenizer ?? approximateTokenizer();
    const maxTokens =
      this._options.maxVectorUnitTokens ??
      Math.min(DEFAULT_MAX_VECTOR_UNIT_TOKENS, this.embedder.maxSeqLength);
    const overlap =
      this._options.vectorUnitOverlapTokens ?? DEFAULT_VECTOR_UNIT_OVERLAP_TOKENS;

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
      res.writeHead(403);
      res.end("Forbidden: loopback only\n");
      return;
    }

    const origin = req.headers["origin"];
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
      res.writeHead(403);
      res.end("Forbidden: invalid Origin\n");
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname !== "/health" && req.method !== "OPTIONS") {
      const auth = req.headers["authorization"];
      if (!auth || !auth.startsWith("Bearer ") || auth.slice(7) !== this.token) {
        res.writeHead(401);
        res.end("Unauthorized\n");
        return;
      }
    }

    if (url.pathname === "/mcp") {
      if (this.mcpHandler) {
        return this.mcpHandler.handle(req, res, url);
      }
      res.writeHead(503);
      res.end("Service not initialized\n");
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
      res.writeHead(404);
      res.end("Not found\n");
      return;
    }

    if (req.method === "POST") {
      if (url.pathname === "/search") return this._handleSearch(req, res);
      if (url.pathname === "/projects") return this._handlePostProjects(req, res);
      if (url.pathname === "/grants") return this._handlePostGrants(req, res);
      if (url.pathname === "/grants/evaluate") return this._handleEvaluateGrants(req, res);
      if (url.pathname === "/sync") return this._handleSync(req, res);
      if (url.pathname === "/prune") return this._handlePrune(req, res);
      if (url.pathname === "/reembed") return this._handleReembed(req, res);
      if (url.pathname === "/pause") return this._handlePauseResume(req, res, "paused");
      if (url.pathname === "/resume") return this._handlePauseResume(req, res, "active");
      if (url.pathname === "/shutdown") return this._handleShutdown(req, res);
      res.writeHead(404);
      res.end("Not found\n");
      return;
    }

    if (req.method === "DELETE") {
      if (url.pathname === "/grants") return this._handleDeleteGrants(req, res);
      res.writeHead(404);
      res.end("Not found\n");
      return;
    }

    res.writeHead(405);
    res.end("Method not allowed\n");
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

  /** ADR-022 error envelope — the shape the CLI already parses. */
  private sendError(
    res: ServerResponse,
    status: number,
    code: string,
    message: string,
    remedy?: string,
    details?: Record<string, unknown>,
  ): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code, message, remedy, details } }));
  }

  private async _handleSearch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    let queryOpts: Record<string, unknown>;
    try {
      queryOpts = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end("Bad request: invalid JSON\n");
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
      res.writeHead(503);
      res.end("Service not initialized\n");
      return;
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
      this.sendError(res, 500, "SEARCH_FAILED", (err as Error).message);
    }
  }

  private async _handleGetProjects(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.db) {
      res.writeHead(503);
      res.end("Service not initialized\n");
      return;
    }

    try {
      const rows = await this.db.table("projects").query().limit(1000).toArray();
      const projects = (rows as Array<Record<string, unknown>>).map((row) => ({
        projectId: row.projectId,
        rootUri: row.rootUri,
        status: row.status,
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(projects));
    } catch {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("[]");
    }
  }

  private async _handlePostProjects(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    let projectOpts: Record<string, unknown>;
    try {
      projectOpts = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end("Bad request: invalid JSON\n");
      return;
    }

    const projectId = projectOpts.projectId as string | undefined;
    let rootUri = projectOpts.rootUri as string | undefined;

    if (!projectId || !rootUri) {
      res.writeHead(400);
      res.end("Bad request: 'projectId' and 'rootUri' required\n");
      return;
    }

    // Strip file:// prefix for filesystem operations
    const dirPath = rootUri.replace(/^file:\/\//, "");

    try {
      statSync(dirPath);
    } catch {
      res.writeHead(400);
      res.end(`Bad request: directory '${dirPath}' does not exist\n`);
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
      res.writeHead(500);
      res.end((err as Error).message + "\n");
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ projectId, rootUri, status: "active" }));
  }

  private async _handleSync(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.ingestionQueue) {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, flushedFiles: 0, pendingFiles: 0, failedFiles: [] }));
      return;
    }

    try {
      // Drain until the queue and the writes it dispatched are both quiet, so a
      // caller can search for a file immediately after /sync returns.
      const before = this.ingestionQueue.pendingCount();
      const failedBefore = this._failed.size;
      await this.ingestionQueue.flushAll();
      await this.awaitInflight();
      const failed = [...this._failed];
      this._failed.clear();

      const pending = this.ingestionQueue.pendingCount();
      res.writeHead(pending === 0 ? 200 : 202, {
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify({
        ok: pending === 0,
        flushedFiles: Math.max(0, before - pending),
        pendingFiles: pending,
        failedFiles: failed,
        hadNewFailures: this._failed.size > 0 || failed.length > failedBefore,
      }));
    } catch (err) {
      this.sendError(res, 500, "SYNC_FAILED", (err as Error).message);
    }
  }

  private async _handleGetGrants(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.db) {
      res.writeHead(503);
      res.end("Service not initialized\n");
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
      res.writeHead(400);
      res.end("Bad request: invalid JSON\n");
      return;
    }

    if (!opts.pattern || !opts.action) {
      res.writeHead(400);
      res.end("Bad request: 'pattern' and 'action' required\n");
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

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ pattern: opts.pattern, action: opts.action }));
  }

  private async _handleEvaluateGrants(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    let opts: { uri: string };
    try {
      opts = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end("Bad request: invalid JSON\n");
      return;
    }

    if (!opts.uri) {
      res.writeHead(400);
      res.end("Bad request: 'uri' required\n");
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
      res.writeHead(400);
      res.end("Bad request: invalid JSON\n");
      return;
    }

    if (!opts.pattern) {
      res.writeHead(400);
      res.end("Bad request: 'pattern' required\n");
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
      res.writeHead(503);
      res.end("Service not initialized\n");
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
      this.sendError(res, 500, "INTERNAL", `prune failed: ${(err as Error).message}`);
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
      res.writeHead(503);
      res.end("Service not initialized or no embedder configured\n");
      return;
    }

    let requeued = 0;

    try {
      const chunks = await this.db.table("chunks_pool")
        .query()
        .limit(10000)
        .toArray() as Array<{ chunkHash: string; text: string }>;

      if (chunks.length === 0) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ requeued: 0, total: 0 }));
        return;
      }

      // Clear existing vectors first
      await this.db.table("vector_pool").delete("true");

      // Re-embed in batches
      const batchSize = 50;
      for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        const texts = batch.map((c) => c.text);
        const vectors = await this.embedder.embedBatch(texts);

        await upsertVectorPool(this.db.table("vector_pool"),
          batch.map((c, j) => ({
            chunkHash: c.chunkHash,
            unitIndex: 0,
            vector: vectors[j],
          })),
        );
        requeued += batch.length;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ requeued, total: chunks.length }));
    } catch {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ requeued: 0, total: 0 }));
    }
  }

  private async _handlePauseResume(req: IncomingMessage, res: ServerResponse, newStatus: string): Promise<void> {
    const body = await readBody(req);
    let opts: { projectId: string };
    try {
      opts = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end("Bad request: invalid JSON\n");
      return;
    }

    if (!opts.projectId) {
      res.writeHead(400);
      res.end("Bad request: 'projectId' required\n");
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
