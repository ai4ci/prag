// @prag/cli — Typed HTTP client for the prag daemon loopback API
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  resolvePragPaths,
  loadPragConfig,
  exitForCode,
  type SearchResult,
  type FailureCode,
  type ErrorEnvelope,
} from "@prag/core";

const DEFAULT_PORT = 7724;
const API_VERSION = 1;
const SPAWN_TIMEOUT_MS = 5_000;
const HEALTH_POLL_MS = 100;

export interface SearchOptions {
  query: string;
  projectId?: string;
  /**
   * File versions of one branch (plus '$default'). Only valid with projectId —
   * a branch identifies a version of one repository. Omitted = every branch.
   */
  branch?: string;
  limit?: number;
  mode?: "hybrid" | "vector" | "fts";
}

// The daemon's search shape is defined once, in @prag/core; the client re-uses
// it rather than keeping a second copy that can drift (it had: `filePath` for a
// field the daemon sends as `uri`, so every hit printed as "File: undefined").
export type {
  SearchResult,
  SearchFileHit,
  SearchChunkHit,
  SearchMode,
} from "@prag/core";


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
  embeddingModel?: string;
  embeddingDim?: number;
  /** Live ingestion counters, absent when ingestion is disabled. */
  ingestion?: {
    projects: number;
    dirty: number;
    cooling: number;
    inFlight: number;
    perProject: Record<string, Record<string, number>>;
  } | null;
}

export interface ProjectInfo {
  projectId: string;
  rootUri: string;
  status: string;
  /**
   * Per-scan skip counters by reason (`tooLarge`, `binary`, `empty`, `denied`).
   * In-memory on the daemon, deliberately not in the `projects` schema (ADR-023).
   */
  skipped: Record<string, number>;
}

export interface GrantInfo {
  pattern: string;
  action: "allow" | "deny";
  reason?: string;
}

export interface SyncResult {
  ok: boolean;
  /** HTTP 202: drained, but new events arrived meanwhile, so more is pending. */
  flushedFiles?: number;
  pendingFiles?: number;
  failedFiles?: string[];
  hadNewFailures?: boolean;
}

export interface PruneResult {
  prunedFiles: number;
  purgedChunks: number;
  prunedBranches: number;
  gcChunks: boolean;
}

export interface ReembedResult {
  requeued: number;
}

export class DaemonError extends Error {
  constructor(
    public readonly code: FailureCode,
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

/**
 * Port to talk to, with the daemon's own precedence: PRAG_PORT, then
 * `server.port` in config.json, then the default. The CLI used to skip the middle
 * step, so a reader who followed env-and-storage-paths.md and set `server.port`
 * got a daemon on that port (it reads config.json) and a CLI knocking on 7724.
 * Read-only on purpose — resolving paths must not create directories.
 */
function readPort(): number {
  const env = Number(process.env.PRAG_PORT);
  if (env) return env;
  try {
    return loadPragConfig(resolvePragPaths().configDir).server?.port || DEFAULT_PORT;
  } catch {
    // Malformed config.json is the daemon's hard error to raise, not ours;
    // `prag status` should still report what it can.
    return DEFAULT_PORT;
  }
}

/**
 * Maps a transport-level failure onto a code, so a dead daemon and a rejected
 * request are distinguishable by `code` rather than by message text.
 *
 * shortcut: any HTTP status that arrives without an envelope is reported as
 * DAEMON_UNREACHABLE; upgrade when every 4xx/5xx path returns an envelope.
 */
function classifyFailure(status: number, detail: string): { code: FailureCode; message: string } {
  const message = detail.trim() || `HTTP ${status}`;
  if (status === 401) return { code: "UNAUTHORIZED", message };
  if (status === 403) return { code: "ORIGIN_REJECTED", message };
  if (status === 404) return { code: "NOT_FOUND", message };
  if (status === 405) return { code: "METHOD_NOT_ALLOWED", message };
  if (status === 503) return { code: "SERVICE_UNAVAILABLE", message };
  return { code: "DAEMON_UNREACHABLE", message };
}

function parseError(status: number, body: string): DaemonError {
  try {
    const env = JSON.parse(body) as ErrorEnvelope;
    if (env?.error?.code) {
      return new DaemonError(
        env.error.code,
        env.error.message,
        env.error.remedy,
        env.error.details,
        status,
      );
    }
  } catch {
    /* body is not an envelope; classify it below */
  }
  const { code, message } = classifyFailure(status, body);
  return new DaemonError(code, message, undefined, undefined, status);
}

async function readBody(res: Response): Promise<string> {
  return await res.text();
}

export interface WatchResult {
  projectId: string;
  rootUri: string;
  status: string;
  discovered: {
    projects: number;
    files: number;
    skipped: Record<string, number>;
  };
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
export { exitForCode };

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
      baseUrl === undefined ? readPort() : this.#portFromUrl(baseUrl);
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
    const port = () => this.baseUrl.slice(this.baseUrl.lastIndexOf(":") + 1);
    const h = await this.health();
    if (!h) throw new DaemonError("DAEMON_NOT_RUNNING", "Daemon is not running");
    if (h.service !== "prag-daemon") {
      // ADR-016: a live listener that does not answer as prag is an identity
      // mismatch, not a transport failure — exit 4, not 3.
      throw new DaemonError(
        "DAEMON_IDENTITY_MISMATCH",
        `port ${port()} is answered by a different process`,
        "Set PRAG_PORT or server.port in config.json, or stop the conflicting process.",
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
      "DAEMON_NOT_RUNNING",
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
      branch: opts.branch,
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

  async addGrant(
    pattern: string,
    action: "allow" | "deny",
    reason?: string,
  ): Promise<{ pattern: string; action: string; purgedFiles?: number; unwatched?: string | null }> {
    const { status, body } = await this._request("POST", "/grants", { pattern, action, reason });
    if (status !== 200) throw parseError(status, body);
    try {
      return JSON.parse(body);
    } catch {
      return { pattern, action };
    }
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

  /**
   * Grant-gated registration with a discovery dry run (ADR-009, ADR-023).
   * Throws WATCH_LIMIT_EXCEEDED when the tree is bigger than
   * `ingestion.watchConfirmThreshold` and `confirm` is false.
   */
  async watchUri(
    uri: string,
    projectId?: string,
    confirm = false,
  ): Promise<WatchResult> {
    const { status, body } = await this._request("POST", "/projects/watch", {
      uri,
      ...(projectId ? { projectId } : {}),
      ...(confirm ? { confirm: true } : {}),
    });
    if (status !== 200) throw parseError(status, body);
    return JSON.parse(body) as WatchResult;
  }

  // ── Sync ─────────────────────────────────────────────────

  /**
   * Drain barrier (ADR-019). Resolves once the queue is empty and the writes are
   * committed; `ok: false` / HTTP 202 means events arrived faster than they could
   * be written. A drain that hit its deadline is SYNC_TIMEOUT (HTTP 504).
   */
  async sync(projectId?: string): Promise<SyncResult> {
    const { status, body } = await this._request("POST", "/sync", projectId ? { projectId } : undefined);
    if (status !== 200 && status !== 202) throw parseError(status, body);
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
    if (status !== 200) {
      throw new DaemonError("SHUTDOWN_FAILED", "Daemon did not acknowledge shutdown");
    }
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
