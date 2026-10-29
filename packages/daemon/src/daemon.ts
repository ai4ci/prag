// @prag/daemon — Local HTTP daemon for prag
//
// Binds to 127.0.0.1, authenticates via PRAG_API_KEY, and exposes
// endpoints: GET /health, POST /search, GET /projects, POST /shutdown,
// and GET/POST /mcp for the MCP SSE interface.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  type LanceDbSchema,
  type EmbeddingProvider,
  type SearchResult,
  hybridSearch,
} from "@prag/core";

import { McpHandler } from "./mcp-server.js";

// ── Config ────────────────────────────────────────────────────────────

const DEFAULT_PORT = 7724;
const API_VERSION = 1;

export interface DaemonConfig {
  port?: number;
  token?: string;
  dataDir?: string;
}

export function loadConfig(): DaemonConfig {
  const configPath = join(homedir(), ".config", "prag", "config.json");
  let config: DaemonConfig = {};
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      config = JSON.parse(raw) as DaemonConfig;
    } catch {
      // ignore malformed config, use defaults
    }
  }

  // PRAG_API_KEY env var takes precedence
  config.token = process.env.PRAG_API_KEY ?? config.token ?? "guest";
  config.port = config.port ?? DEFAULT_PORT;
  config.dataDir = config.dataDir ?? join(homedir(), ".local", "share", "prag");
  return config;
}

// ── Daemon ────────────────────────────────────────────────────────────

export class Daemon {
  private server: ReturnType<typeof createServer> | null = null;
  private startTime = 0;
  private db: LanceDbSchema | null = null;
  private embedder: EmbeddingProvider | null = null;
  private mcpHandler: McpHandler | null = null;
  private token: string;

  constructor(
    readonly config: DaemonConfig,
  ) {
    this.token = config.token ?? "guest";
  }

  /** Start the HTTP server. */
  async start(
    db: LanceDbSchema,
    embedder: EmbeddingProvider,
  ): Promise<void> {
    this.db = db;
    this.embedder = embedder;
    this.mcpHandler = new McpHandler(db, embedder);
    this.startTime = Date.now();

    return new Promise((resolve) => {
      this.server = createServer((req, res) => this._handle(req, res));
      this.server.listen(this.config.port, "127.0.0.1", () => {
        resolve();
      });
    });
  }

  /** Graceful shutdown. */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.mcpHandler) {
        this.mcpHandler.close().catch(() => {});
      }
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  get listening(): boolean {
    return this.server?.listening ?? false;
  }

  // ── Request handling ──────────────────────────────────────────────

  private _handle(req: IncomingMessage, res: ServerResponse): void {
    // Strict loopback check
    const addr = req.socket.remoteAddress;
    if (addr !== "127.0.0.1" && addr !== "::1" && addr !== "::ffff:127.0.0.1") {
      res.writeHead(403);
      res.end("Forbidden: loopback only\n");
      return;
    }

    // Reject non-localhost Origin
    const origin = req.headers["origin"];
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
      res.writeHead(403);
      res.end("Forbidden: invalid Origin\n");
      return;
    }

    // Auth (except GET /health)
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== "/health" && req.method !== "OPTIONS") {
      const auth = req.headers["authorization"];
      if (!auth || !auth.startsWith("Bearer ") || auth.slice(7) !== this.token) {
        res.writeHead(401);
        res.end("Unauthorized\n");
        return;
      }
    }

    // Route
    switch (url.pathname) {
      case "/health":
        return this._handleHealth(req, res);
      case "/search":
        return this._handleSearch(req, res);
      case "/projects":
        return this._handleProjects(req, res);
      case "/shutdown":
        return this._handleShutdown(req, res);
      case "/mcp":
        return this.mcpHandler
          ? this.mcpHandler.handle(req, res, url)
          : (res.writeHead(503), void res.end("Service not initialized\n"));
      default:
        res.writeHead(404);
        res.end("Not found\n");
    }
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
    }));
  }

  private async _handleSearch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Read body
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

  private async _handleProjects(_req: IncomingMessage, res: ServerResponse): Promise<void> {
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

  private _handleShutdown(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200);
    res.end("Shutting down\n");
    // Schedule shutdown after response is sent
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
