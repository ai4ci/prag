// @prag/cli — Typed HTTP client for the prag daemon loopback API
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolvePragPaths } from "@prag/core";

const DEFAULT_PORT = 7724;
const API_VERSION = 1;
const SPAWN_TIMEOUT_MS = 5_000;
const HEALTH_POLL_MS = 100;

export interface SearchOptions {
  query: string;
  projectId?: string;
  limit?: number;
  mode?: "hybrid" | "vector" | "fts";
}

export interface SearchHit {
  filePath: string;
  projectId: string;
  score: number;
  totalChunks: number;
  branch: string;
}

export interface SearchResult {
  hits: SearchHit[];
  totalChunks: number;
}

export interface HealthResponse {
  status: string;
  service: string;
  apiVersion: number;
  pid: number;
  port: number;
  version: string;
  uptime: number;
  root: string | null;
  dataDir: string;
  configDir: string;
  runDir: string;
}

export interface ProjectInfo {
  projectId: string;
  rootUri: string;
  status: string;
}

export interface GrantInfo {
  pattern: string;
  action: "allow" | "deny";
  reason?: string;
}

export interface SyncResult {
  ok: boolean;
  flushedFiles?: number;
  pendingFiles?: number;
}

export interface PruneResult {
  prunedBranches: number;
  purgedChunks: number;
}

export interface ReembedResult {
  requeued: number;
}

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    remedy?: string;
    details?: Record<string, unknown>;
  };
}

export class DaemonError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly remedy?: string,
    public readonly details?: Record<string, unknown>,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "DaemonError";
  }
}

function readToken(): string {
  const envToken = process.env.PRAG_API_KEY;
  if (envToken) return envToken;

  try {
    const paths = resolvePragPaths();
    const tokenPath = join(paths.runDir, "daemon.token");
    if (existsSync(tokenPath)) {
      return readFileSync(tokenPath, "utf-8").trim();
    }
  } catch {
    // Ignore — fall through to default
  }

  return "guest";
}

function parseError(status: number, body: string): DaemonError {
  try {
    const env = JSON.parse(body) as ErrorEnvelope;
    return new DaemonError(
      env.error.code,
      env.error.message,
      env.error.remedy,
      env.error.details,
      status,
    );
  } catch {
    return new DaemonError(
      "HTTP_ERROR",
      body.trim() || `HTTP ${status}`,
      undefined,
      undefined,
      status,
    );
  }
}

async function readBody(res: Response): Promise<string> {
  return await res.text();
}

enum ExitCode {
  SUCCESS = 0,
  FAILURE = 1,
  USAGE = 2,
  NO_DAEMON = 3,
  VERSION_MISMATCH = 4,
  AUTH_ERROR = 5,
  EMBEDDING_MISMATCH = 6,
  NOT_GRANTED = 7,
  TIMEOUT = 8,
}

export { ExitCode };

/**
 * Typed client for the prag daemon loopback HTTP API.
 */
export class DaemonClient {
  readonly baseUrl: string;
  readonly token: string;

  constructor(
    baseUrl?: string,
    token?: string,
  ) {
    const port =
      baseUrl === undefined ? Number(process.env.PRAG_PORT ?? DEFAULT_PORT) : this.#portFromUrl(baseUrl);
    this.baseUrl = baseUrl ?? `http://127.0.0.1:${port}`;
    this.token = token ?? readToken();
  }

  toString(): string {
    return `DaemonClient(baseUrl=${this.baseUrl})`;
  }

  private async _request(
    method: string,
    path: string,
    body?: unknown,
    skipAuth = false,
  ): Promise<{ status: number; body: string; headers: Headers }> {
    const headers: Record<string, string> = {};

    if (!skipAuth) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await readBody(res);
    return { status: res.status, body: text, headers: res.headers };
  }

  /**
   * Check daemon health and validate apiVersion.
   * Returns the health response on success, or null if unreachable.
   */
  async health(): Promise<HealthResponse | null> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      });

      if (res.status !== 200) {
        await res.body?.cancel();
        return null;
      }
      const body = await res.text();
      const h = JSON.parse(body) as HealthResponse;
      return h;
    } catch {
      return null;
    }
  }

  /**
   * Check health and validate apiVersion+service.
   * Throws DaemonError on mismatch.
   */
  async checkHealth(): Promise<HealthResponse> {
    const h = await this.health();
    if (!h) throw new DaemonError("NO_DAEMON", "Daemon is not running");
    if (h.service !== "prag-daemon") {
      throw new DaemonError(
        "PORT_CONFLICT",
        `Port ${this.baseUrl.slice(this.baseUrl.lastIndexOf(":") + 1)} is in use by a different process. ` +
          "Set PRAG_PORT or server.port in config.json to use a different port, or stop the conflicting process.",
        "Set PRAG_PORT or server.port in config.json to use a different port, or stop the conflicting process.",
      );
    }
    return h;
  }

  /**
   * Check apiVersion match. Callers that must be exempt pass skipApiCheck = true.
   */
  checkApiVersion(h: HealthResponse, skipApiCheck = false): void {
    if (skipApiCheck) return;
    if (h.apiVersion !== API_VERSION) {
      throw new DaemonError(
        "API_VERSION_MISMATCH",
        `Daemon speaks API version ${h.apiVersion}, this CLI speaks ${API_VERSION}. ` +
          "Run `prag daemon stop` to let it respawn at the current version.",
        "Run `prag daemon stop` to let it respawn at the current version.",
        { daemonApiVersion: h.apiVersion, cliApiVersion: API_VERSION },
      );
    }
  }

  // ── Daemon lifecycle ────────────────────────────────────

  /** Spawn the daemon and wait for it to become ready. */
  async spawnDaemon(): Promise<HealthResponse> {
    // Source layout first (npm workspaces, tsx), then the built layout.
    const source = join(import.meta.dirname!, "..", "..", "daemon", "src", "main.ts");
    const entry = existsSync(source)
      ? source
      : join(import.meta.dirname!, "..", "..", "daemon", "dist", "main.js");

    const proc = spawn(
      process.execPath,
      ["--import", "tsx", entry],
      {
        stdio: "ignore",
        detached: true,
        env: { ...process.env, PRAG_PORT: String(this.#portFromUrl()) },
      },
    );
    proc.unref();

    // Poll health
    const deadline = Date.now() + SPAWN_TIMEOUT_MS;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        const h = await this.health();
        if (h && h.service === "prag-daemon") return h;
      } catch (e) {
        lastErr = e;
      }
      await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
    }

    throw new DaemonError(
      "NO_DAEMON",
      "Could not start daemon — timed out waiting for /health to respond.",
      "Check that @prag/daemon can start without errors, or set PRAG_PORT to a port your daemon can bind to.",
    );
  }

  #portFromUrl(url?: string): number {
    const target = url ?? this.baseUrl;
    const m = target.match(/:(\d+)$/);
    return m ? Number(m[1]) : DEFAULT_PORT;
  }

  // ── Search ───────────────────────────────────────────────

  async search(opts: SearchOptions): Promise<SearchResult> {
    const { status, body } = await this._request("POST", "/search", {
      query: opts.query,
      projectId: opts.projectId,
      limit: opts.limit ?? 5,
      mode: opts.mode ?? "hybrid",
    });

    if (status !== 200) throw parseError(status, body);

    const raw = JSON.parse(body);
    return raw as SearchResult;
  }

  // ── Grants ───────────────────────────────────────────────

  async listGrants(): Promise<GrantInfo[]> {
    const { status, body } = await this._request("GET", "/grants");
    if (status !== 200) throw parseError(status, body);
    return JSON.parse(body) as GrantInfo[];
  }

  async addGrant(pattern: string, action: "allow" | "deny", reason?: string): Promise<void> {
    const { status, body } = await this._request("POST", "/grants", { pattern, action, reason });
    if (status !== 200) throw parseError(status, body);
  }

  async removeGrant(pattern: string): Promise<void> {
    const { status, body } = await this._request("DELETE", "/grants", { pattern });
    if (status !== 200) throw parseError(status, body);
  }

  async evaluateGrant(uri: string): Promise<{ matched: boolean; action: string | null; pattern: string | null }> {
    const { status, body } = await this._request("POST", "/grants/evaluate", { uri });
    if (status !== 200) throw parseError(status, body);
    return JSON.parse(body);
  }

  // ── Projects ─────────────────────────────────────────────

  async listProjects(): Promise<ProjectInfo[]> {
    const { status, body } = await this._request("GET", "/projects");
    if (status !== 200) throw parseError(status, body);
    return JSON.parse(body) as ProjectInfo[];
  }

  async registerProject(projectId: string, rootUri: string): Promise<void> {
    const { status, body } = await this._request("POST", "/projects", { projectId, rootUri });
    if (status !== 200) throw parseError(status, body);
  }

  // ── Sync ─────────────────────────────────────────────────

  async sync(): Promise<SyncResult> {
    const { status, body } = await this._request("POST", "/sync");
    if (status !== 200) throw parseError(status, body);
    return JSON.parse(body) as SyncResult;
  }

  // ── Prune ────────────────────────────────────────────────

  async prune(gcChunks?: boolean): Promise<PruneResult> {
    const { status, body } = await this._request("POST", "/prune", { gcChunks: gcChunks ?? false });
    if (status !== 200) throw parseError(status, body);
    return JSON.parse(body) as PruneResult;
  }

  // ── Reembed ──────────────────────────────────────────────

  async reembed(model?: string): Promise<ReembedResult> {
    const { status, body } = await this._request("POST", "/reembed", { model });
    if (status !== 200) throw parseError(status, body);
    return JSON.parse(body) as ReembedResult;
  }

  // ── Pause / Resume ───────────────────────────────────────

  async pause(projectId: string): Promise<void> {
    const { status } = await this._request("POST", "/pause", { projectId });
    if (status !== 200) throw parseError(status, `Failed to pause ${projectId}`);
  }

  async resume(projectId: string): Promise<void> {
    const { status } = await this._request("POST", "/resume", { projectId });
    if (status !== 200) throw parseError(status, `Failed to resume ${projectId}`);
  }

  // ── Shutdown ─────────────────────────────────────────────

  async shutdown(): Promise<void> {
    const { status } = await this._request("POST", "/shutdown");
    if (status !== 200) throw new DaemonError("SHUTDOWN_FAILED", "Daemon did not acknowledge shutdown");
  }

  // ── Status (infer project from cwd) ──────────────────────

  async inferProjectId(): Promise<string | null> {
    const projects = await this.listProjects();
    const cwd = process.cwd();

    // Find the project with the longest matching rootUri prefix
    let best: string | null = null;
    let bestLen = 0;
    for (const p of projects) {
      const prefix = p.rootUri.replace(/^file:\/\//, "");
      if (cwd.startsWith(prefix) && prefix.length > bestLen) {
        best = p.projectId;
        bestLen = prefix.length;
      }
    }
    return best;
  }
}
