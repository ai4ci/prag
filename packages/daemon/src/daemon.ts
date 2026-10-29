// @prag/daemon — Local HTTP daemon for prag
//
// Binds to 127.0.0.1, authenticates via PRAG_API_KEY, and exposes
// endpoints: GET /health, POST /search, GET /projects, POST /projects,
// POST /sync, POST /shutdown, and GET/POST /mcp for the MCP SSE interface.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { statSync } from "node:fs";
import { join } from "node:path";

import {
  type LanceDbSchema,
  type EmbeddingProvider,
  type SearchResult,
  resolvePragPaths,
  loadPragConfig,
  type PragPaths,
  hybridSearch,
  upsertProjects,
  upsertFileMapping,
  upsertChunkMapping,
  upsertChunksPool,
  upsertVectorPool,
} from "@prag/core";

import { McpHandler } from "./mcp-server.js";
import { WorkerPool } from "./worker-pool.js";
import { IngestionQueue } from "./ingestion-queue.js";
import { type ProcessResult } from "./worker-pool.js";

// ── Config ────────────────────────────────────────────────────────────

const DEFAULT_PORT = 7724;
const API_VERSION = 1;

export interface DaemonConfig {
  port?: number;
  token?: string;
  paths?: PragPaths;
  ingestion?: {
    cooldownMs?: number;
    maxFileBytes?: number;
    poolSize?: number;
  };
}

export function loadConfig(): DaemonConfig {
  const paths = resolvePragPaths();
  const config = loadPragConfig(paths.configDir);

  const port = Number(process.env.PRAG_PORT) || config.server?.port || DEFAULT_PORT;
  const token = process.env.PRAG_API_KEY ?? "guest";

  return { port, token, paths };
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

  constructor(
    readonly config: DaemonConfig,
  ) {
    this.token = config.token ?? "guest";
    this.paths = config.paths ?? resolvePragPaths();
  }

  /** Start the HTTP server. */
  async start(
    db: LanceDbSchema,
    embedder: EmbeddingProvider,
  ): Promise<void> {
    this.db = db;
    this.embedder = embedder;
    this.mcpHandler = new McpHandler(db, embedder);

    // Start ingestion pipeline if configured
    const ingConfig = this.config.ingestion;
    if (ingConfig?.poolSize !== undefined && ingConfig.poolSize > 0) {
      this.workerPool = new WorkerPool(ingConfig.poolSize);
      this.ingestionQueue = new IngestionQueue(
        this.workerPool,
        (result) => this._onFileProcessed(result).catch(() => {}),
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
    if (this.ingestionQueue) {
      await this.ingestionQueue.close();
    }
    if (this.workerPool) {
      await this.workerPool.close();
    }
    if (this.mcpHandler) {
      await this.mcpHandler.close();
    }
    return new Promise((resolve) => {
      if (this.server) {
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
      console.error("[prag] Ingestion error for", result.filePath, ":", result.error);
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

    // Delete chunk_mapping entries
    const cmTable = this.db.table("chunk_mapping");
    const chunkMaps = await cmTable.query()
      .filter(`fileVersionId = '${fileVersionId}'`)
      .limit(10000)
      .toArray() as Array<{ chunkHash: string }>;

    for (const cm of chunkMaps) {
      await this.db.table("chunks_pool").delete(`chunkHash = '${cm.chunkHash}'`);
      await this.db.table("vector_pool").delete(`chunkHash = '${cm.chunkHash}'`);
    }

    await this.db.table("chunk_mapping").delete(`fileVersionId = '${fileVersionId}'`);
    await this.db.table("file_mapping").delete(`fileVersionId = '${fileVersionId}'`);
  }

  private async _ingestFile(result: ProcessResult): Promise<void> {
    if (!this.db || !this.embedder) return;

    const texts = result.chunks.map((c) => c.text);
    const embeddings = await this.embedder.embedBatch(texts);

    // Upsert file_mapping
    const fileVersionId = crypto.randomUUID();
    const fmRow = {
      fileVersionId,
      projectId: result.projectId,
      uri: result.filePath,
      validUntil: null as Date | null,
      contentHash: "",
      language: result.language,
    };
    await upsertFileMapping(this.db.table("file_mapping"), [fmRow]);

    // Build rows for each table
    const cmRows: Array<{ fileVersionId: string; chunkIndex: number; chunkHash: string }> = [];
    const cpRows: Array<{ chunkHash: string; text: string; scopeContext: string | null }> = [];
    const vpRows: Array<{ chunkHash: string; unitIndex: number; vector: Float32Array }> = [];

    for (let i = 0; i < result.chunks.length; i++) {
      const c = result.chunks[i];
      const vec = embeddings[i] ?? embeddings[embeddings.length - 1];

      cmRows.push({ chunkHash: c.chunkHash, fileVersionId, chunkIndex: i });
      cpRows.push({
        chunkHash: c.chunkHash,
        text: c.text,
        scopeContext: c.scopeContext || null,
      });
      vpRows.push({ chunkHash: c.chunkHash, unitIndex: 0, vector: vec });
    }

    await upsertChunkMapping(this.db.table("chunk_mapping"), cmRows);
    await upsertChunksPool(this.db.table("chunks_pool"), cpRows);
    await upsertVectorPool(this.db.table("vector_pool"), vpRows);
  }

  // ── Request handling ──────────────────────────────────────────────

  private _handle(req: IncomingMessage, res: ServerResponse): void {
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

    if (req.method === "GET") {
      if (url.pathname === "/health") return this._handleHealth(req, res);
      if (url.pathname === "/projects") return this._handleGetProjects(req, res);
      res.writeHead(404);
      res.end("Not found\n");
      return;
    }

    if (req.method === "POST") {
      if (url.pathname === "/search") return this._handleSearch(req, res);
      if (url.pathname === "/projects") return this._handlePostProjects(req, res);
      if (url.pathname === "/sync") return this._handleSync(req, res);
      if (url.pathname === "/shutdown") return this._handleShutdown(req, res);
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
      status: "ok",
      service: "prag-daemon",
      apiVersion: API_VERSION,
      pid: process.pid,
      version: "0.1.0",
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      port: this.config.port,
      root: this.paths.root || null,
      dataDir: this.paths.dataDir,
      configDir: this.paths.configDir,
      runDir: this.paths.runDir,
    }));
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

    if (!queryText) {
      res.writeHead(400);
      res.end("Bad request: 'query' field required\n");
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
      );

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500);
      res.end(`Internal error: ${(err as Error).message}\n`);
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
    const rootUri = projectOpts.rootUri as string | undefined;

    if (!projectId || !rootUri) {
      res.writeHead(400);
      res.end("Bad request: 'projectId' and 'rootUri' required\n");
      return;
    }

    try {
      statSync(rootUri);
    } catch {
      res.writeHead(400);
      res.end(`Bad request: directory '${rootUri}' does not exist\n`);
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
      this.registerProject(projectId, rootUri);
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
      res.end(JSON.stringify({ ok: true, message: "ingestion not enabled" }));
      return;
    }

    try {
      await this.ingestionQueue.flushAll();
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500);
      res.end(`Internal error: ${(err as Error).message}\n`);
    }
  }

  private _handleShutdown(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200);
    res.end("Shutting down\n");
    setTimeout(() => {
      this.stop().then(() => process.exit(0)).catch(() => process.exit(1));
    }, 100);
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
