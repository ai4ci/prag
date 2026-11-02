// @prag/daemon — MCP server (HTTP/SSE transport)
//
// Mounted by the daemon at /mcp. GET establishes SSE stream,
// POST receives JSON-RPC messages on the returned endpoint.
//
// Tools:
//   search_local  — search indexed content scoped to a project
//   list_grants   — list registered grant rules
//   list_projects — list registered workspace projects

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import * as z from "zod";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";

import {
  type LanceDbSchema,
  type EmbeddingProvider,
  hybridSearch,
} from "@prag/core";

// ── Handler ───────────────────────────────────────────────────────────

export class McpHandler {
  private transports = new Map<string, SSEServerTransport>();
  private server: McpServer;

  constructor(
    private db: LanceDbSchema,
    private embedder: EmbeddingProvider,
  ) {
    this.server = this._buildServer();
  }

  /** Shared search path so both tools build the candidate pool identically. */
  private _search(query: string, limit: number, projectId?: string) {
    return hybridSearch(
      this.db.table("chunks_pool"),
      this.db.table("vector_pool"),
      this.db.table("chunk_mapping"),
      this.db.table("file_mapping"),
      this.embedder,
      query,
      limit,
      undefined,
      { projectId, mode: "hybrid" },
    );
  }

  /** Handle an incoming request: GET → SSE stream, POST → JSON-RPC message. */
  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    if (req.method === "GET") {
      return this._handleSSE(req, res);
    }
    if (req.method === "POST") {
      return this._handleMessage(req, res, url);
    }
    res.writeHead(405);
    res.end("Method not allowed\n");
  }

  /** Close all active transports (called on daemon shutdown). */
  async close(): Promise<void> {
    for (const [id, t] of this.transports) {
      try {
        await t.close();
      } catch {
        // ignore close errors
      }
      this.transports.delete(id);
    }
  }

  // ── Tool definitions ──────────────────────────────────────────────

  private _buildServer(): McpServer {
    const server = new McpServer(
      { name: "prag-daemon", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );

    server.registerTool("search_local", {
      description:
        "Search indexed content scoped to one project. Requires a projectId.",
      inputSchema: {
        query: z.string().describe("Search query"),
        projectId: z.string().describe("Project ID to scope the search to"),
        limit: z
          .number()
          .optional()
          .default(10)
          .describe("Max file-level results"),
      },
    }, async ({ query, projectId, limit }) => {
      try {
        const result = await this._search(query, limit ?? 10, projectId);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ projectId, ...result }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Search error: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    });

    server.registerTool("search_all", {
      description:
        "Search every indexed project (unscoped). Cross-project results only — " +
        "an explicit tool, so search_local never silently widens.",
      inputSchema: {
        query: z.string().describe("Search query"),
        limit: z
          .number()
          .optional()
          .default(10)
          .describe("Max file-level results"),
      },
    }, async ({ query, limit }) => {
      try {
        const result = await this._search(query, limit ?? 10, undefined);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result) },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Search error: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    });

    server.registerTool("list_grants", {
      description: "List all registered grant rules (allow/deny patterns).",
      inputSchema: {},
    }, async () => {
      try {
        const rows = await this.db
          .table("grants")
          .query()
          .limit(1000)
          .toArray();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(rows, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing grants: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    });

    server.registerTool("list_projects", {
      description: "List all registered workspace projects.",
      inputSchema: {},
    }, async () => {
      try {
        const rows = await this.db
          .table("projects")
          .query()
          .limit(1000)
          .toArray();
        const projects = (rows as Array<Record<string, unknown>>).map(
          (r) => ({
            projectId: r.projectId,
            rootUri: r.rootUri,
            status: r.status,
          }),
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(projects, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing projects: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    });

    return server;
  }

  // ── SSE endpoint (GET /mcp) ─────────────────────────────────────────

  private async _handleSSE(
    _req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const transport = new SSEServerTransport("/mcp", res);
      this.transports.set(transport.sessionId, transport);
      transport.onclose = () => {
        this.transports.delete(transport.sessionId);
      };
      await this.server.connect(transport);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Internal server error\n");
      }
    }
  }

  // ── Message endpoint (POST /mcp?sessionId=xxx) ──────────────────────

  private async _handleMessage(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      res.writeHead(400);
      res.end("Missing sessionId\n");
      return;
    }
    const transport = this.transports.get(sessionId);
    if (!transport) {
      res.writeHead(404);
      res.end("Session not found\n");
      return;
    }
    try {
      await transport.handlePostMessage(req, res);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Internal server error\n");
      }
    }
  }
}
