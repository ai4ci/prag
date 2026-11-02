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
 * The daemon-side operations the policy tools need. Passed in rather than
 * reached through the schema, because grants and pruning are daemon policy: an
 * MCP tool that wrote a grant row directly would skip the cache invalidation,
 * the immediate purge from search, and the unwatch that `prag deny` performs
 * (ADR-009 §4), so the two interfaces would disagree about what a deny means.
 */
export interface McpOperations {
  watchUri(opts: {
    uri?: string;
    projectId?: string;
    confirm?: boolean;
    cooldownSeconds?: number;
  }): Promise<Record<string, unknown>>;
  applyGrant(pattern: string, action: string, reason?: string): Promise<Record<string, unknown>>;
  prune(gcChunks?: boolean): Promise<Record<string, unknown>>;
  statusFor(uri: string): Promise<Record<string, unknown>>;
}


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
  // One server per session: the SDK's Protocol throws "Already connected to a
  // transport" if a McpServer is connected twice, so a single shared instance
  // would answer 500 to every GET /mcp after the first live stream — and two
  // agents on one daemon is the expected setup (ADR-019).
  private transports = new Map<string, { transport: SSEServerTransport; server: McpServer }>();

  constructor(
    private db: LanceDbSchema,
    private embedder: EmbeddingProvider,
    private ops: McpOperations,
  ) {}

  /** Shared search path so both tools build the candidate pool identically. */
  private _search(query: string, limit: number, projectId?: string, branch?: string) {
    return hybridSearch(
      this.db.table("chunks_pool"),
      this.db.table("vector_pool"),
      this.db.table("chunk_mapping"),
      this.db.table("file_mapping"),
      this.embedder,
      query,
      limit,
      undefined,
      {
        projectId,
        branch,
        branchMapping: this.db.table("branch_mapping"),
        mode: "hybrid",
      },
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
    for (const [id, entry] of this.transports) {
      try {
        await entry.transport.close();
      } catch {
        // ignore close errors
      }
      this.transports.delete(id);
    }
  }

  // ── Tool definitions ──────────────────────────────────────────────

  /** A fresh tool server for one session (see the transports map for why). */
  private newServer(): McpServer {
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
        branch: z
          .string()
          .optional()
          .describe(
            "Restrict to one branch's file versions (plus '$default'). Omit to search " +
              "every branch of the project; an MCP client knows its own checkout, the daemon cannot.",
          ),
      },
    }, async ({ query, projectId, limit, branch }) => {
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
        const result = await this._search(query, limit ?? 10, projectId, branch);
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

    this._registerPolicyTools(server);

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

  // ── Policy tools (watch_uri, deny_uri, prune_index, get_indexing_status) ──

  private _registerPolicyTools(server: McpServer): void {
    server.registerTool("watch_uri", {
      description:
        "Adds an allow grant and registers a directory or web URL for background indexing.",
      inputSchema: {
        uri: z
          .string()
          .describe(
            "Directory URI (file:///path/to/repo) or documentation URL (https://docs.site.com/**).",
          ),
        cooldownSeconds: z
          .number()
          .optional()
          .describe(
            "Cooldown validity lease delta in seconds for this project (default: the daemon's ingestion.cooldownMs).",
          ),
      },
    }, async ({ uri, cooldownSeconds }) => {
      try {
        // No `confirm` here on purpose: past the threshold this fails with
        // WATCH_LIMIT_EXCEEDED instead of prompting, and the human escalates with
        // `prag watch <uri> --yes` (ADR-023). An agent that could confirm its own
        // watch would be able to waive the guard it is meant to report.
        return { content: [{ type: "text" as const, text: JSON.stringify(await this.ops.watchUri({ uri, cooldownSeconds })) }] };
      } catch (err) {
        return toolFailure(err);
      }
    });

    server.registerTool("deny_uri", {
      description:
        "Excludes a URI pattern from indexing, removing existing chunks from search and halting file watching.",
      inputSchema: {
        uri: z
          .string()
          .describe("The URI pattern to exclude (e.g. file:///path/to/secret/**)."),
      },
    }, async ({ uri }) => {
      try {
        return { content: [{ type: "text" as const, text: JSON.stringify(await this.ops.applyGrant(uri, "deny", "mcp_deny")) }] };
      } catch (err) {
        return toolFailure(err);
      }
    });

    server.registerTool("prune_index", {
      description:
        "Prunes stale branch pointers, and optionally garbage-collects unreferenced content-pool chunks.",
      inputSchema: {
        gcChunks: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Also delete unreferenced chunks_pool rows and compact the table. Defaults to false -- must be explicitly requested.",
          ),
      },
    }, async ({ gcChunks }) => {
      try {
        return { content: [{ type: "text" as const, text: JSON.stringify(await this.ops.prune(Boolean(gcChunks))) }] };
      } catch (err) {
        return toolFailure(err);
      }
    });

    server.registerTool("get_indexing_status", {
      description:
        "Reports whether a workspace is indexed, on which branch, and how many files and chunks are in the index.",
      inputSchema: {
        uri: z
          .string()
          .describe("Workspace URI (file:///path/to/repo) to report on."),
      },
    }, async ({ uri }) => {
      try {
        return { content: [{ type: "text" as const, text: JSON.stringify(await this.ops.statusFor(uri)) }] };
      } catch (err) {
        return toolFailure(err);
      }
    });
  }

  // ── SSE endpoint (GET /mcp) ─────────────────────────────────────────

  private async _handleSSE(
    _req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const transport = new SSEServerTransport("/mcp", res);
      const server = this.newServer();
      this.transports.set(transport.sessionId, { transport, server });
      transport.onclose = () => {
        this.transports.delete(transport.sessionId);
      };
      await server.connect(transport);
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
    const transport = this.transports.get(sessionId)?.transport;
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
