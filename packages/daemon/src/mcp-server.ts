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
  DaemonFailure,
  type ErrorEnvelope,
  type FailureCode,
} from "@prag/core";
import { assertProjectRegistered } from "./project-lookup.js";

/**
 * ADR-022 §2: a failing tool answers `isError: true` whose content is the same
 * envelope the HTTP API returns, so an MCP client branches on `code` exactly as
 * the CLI does. Message text is never the contract.
 *
 * Exported so the mapping is testable without a full MCP session handshake.
 */
export function toolFailure(err: unknown) {
  const failure =
    err instanceof DaemonFailure
      ? err
      : new DaemonFailure("INTERNAL", "the tool could not be completed");
  if (!(err instanceof DaemonFailure)) console.error("[prag] mcp tool failure:", err);
  const envelope: ErrorEnvelope = { error: failure.toEnvelope().error };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
    isError: true,
  };
}

/** Writes an ADR-022 envelope directly (used before the JSON-RPC layer exists). */
function writeEnvelope(
  res: ServerResponse,
  status: number,
  code: FailureCode,
  message: string,
  remedy?: string,
): void {
  const envelope: ErrorEnvelope = {
    error: { code, message, ...(remedy ? { remedy } : {}) },
  };
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(envelope));
}

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
    // ADR-022 §1: no endpoint returns a bare string, not even the transport.
    const envelope: ErrorEnvelope = {
      error: {
        code: "METHOD_NOT_ALLOWED",
        message: `${req.method} is not allowed on /mcp`,
        remedy: "Open the SSE stream with GET, then POST JSON-RPC to the returned endpoint.",
      },
    };
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify(envelope));
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
        projectId: z
          .string()
          .optional()
          .describe("Project ID to scope the search to (required; ADR-018)"),
        limit: z
          .number()
          .optional()
          .default(10)
          .describe("Max file-level results"),
      },
    }, async ({ query, projectId, limit }) => {
      try {
        if (!projectId) {
          // Optional in the schema so the failure arrives as an envelope with a
          // remedy, rather than as a schema-validation error with prose.
          throw new DaemonFailure(
            "PROJECT_ID_REQUIRED",
            "search_local requires a projectId",
            "Pass projectId, or call search_all to search every project.",
          );
        }
        await assertProjectRegistered(this.db, projectId);
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
        return toolFailure(err);
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
        return toolFailure(err);
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
        return toolFailure(err);
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
        return toolFailure(err);
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
        writeEnvelope(res, 500, "INTERNAL", "the MCP stream could not be opened",
          "See the daemon log, or check that the index is open (`prag daemon status`).");
      }
    }
  }

  // ── Message endpoint (POST /mcp?sessionId=xxx) ──────────────────────

  private async _handleMessage(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    // These three checks happen before the JSON-RPC layer, so they answer with
    // the same HTTP envelope as the REST API rather than a JSON-RPC error
    // (ADR-022 §1: no endpoint returns a bare string).
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      writeEnvelope(res, 400, "INVALID_REQUEST", "missing sessionId query parameter",
        "Open the SSE stream with GET /mcp and POST to the endpoint it returns.");
      return;
    }
    const transport = this.transports.get(sessionId);
    if (!transport) {
      writeEnvelope(res, 404, "NOT_FOUND", `unknown MCP session`,
        "Re-open the SSE stream with GET /mcp to obtain a fresh sessionId.");
      return;
    }
    try {
      await transport.handlePostMessage(req, res);
    } catch (err) {
      console.error("[prag] mcp transport failure:", err);
      if (!res.headersSent) {
        writeEnvelope(res, 500, "INTERNAL", "the MCP message could not be handled",
          "See the daemon log for the underlying error.");
      }
    }
  }
}
