// @prag/core — Path resolution with PRAG_ROOT isolation (ADR-019)
//
// Precedence per category:
//   1. explicit PRAG_DATA_DIR / PRAG_CONFIG_DIR / PRAG_RUN_DIR / PRAG_LOG_DIR
//   2. derived from PRAG_ROOT (<root>/data, <root>/config, <root>/state, <root>/state/logs)
//   3. XDG / platform default
//
// When PRAG_ROOT is set, an unset category never falls back to XDG.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Resolved paths ────────────────────────────────────────────────────

export interface PragPaths {
  /** The PRAG_ROOT value, or empty string if unset. */
  root: string;

  /** Directory for LanceDB tables and model caches. */
  dataDir: string;

  /** Directory for config.json. */
  configDir: string;

  /** Directory for PID, port, and runtime state files. */
  runDir: string;

  /** Directory for daemon logs. */
  logDir: string;
}

// ── Resolution ────────────────────────────────────────────────────────

function xdgDataHome(): string {
  return process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
}

function xdgConfigHome(): string {
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
}

function xdgStateHome(): string {
  return process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
}

function xdgDefault(): PragPaths {
  const dataHome = xdgDataHome();
  const configHome = xdgConfigHome();
  const stateHome = xdgStateHome();
  return {
    root: "",
    dataDir: join(dataHome, "prag"),
    configDir: join(configHome, "prag"),
    runDir: join(stateHome, "prag"),
    logDir: join(stateHome, "prag", "logs"),
  };
}

/** Resolve the four base paths from environment variables (ADR-019). */
export function resolvePragPaths(): PragPaths {
  const explicit = (name: string): string | undefined =>
    process.env[name] || undefined;

  const root = process.env.PRAG_ROOT || "";

  const fromRoot = root
    ? {
        dataDir: join(root, "data"),
        configDir: join(root, "config"),
        runDir: join(root, "state"),
        logDir: join(root, "state", "logs"),
      }
    : null;

  const xdg = xdgDefault();

  return {
    root,
    dataDir: explicit("PRAG_DATA_DIR") ?? (fromRoot?.dataDir ?? xdg.dataDir),
    configDir: explicit("PRAG_CONFIG_DIR") ?? (fromRoot?.configDir ?? xdg.configDir),
    runDir: explicit("PRAG_RUN_DIR") ?? (fromRoot?.runDir ?? xdg.runDir),
    logDir: explicit("PRAG_LOG_DIR") ?? (fromRoot?.logDir ?? xdg.logDir),
  };
}

// ── Config file ───────────────────────────────────────────────────────

export interface PragConfig {
  server?: {
    host?: string;
    port?: number;
    debounceMs?: number;
  };
  embedding?: {
    model?: string;
    device?: string;
    batchSize?: number;
    maxVectorUnitTokens?: number;
    vectorUnitOverlapTokens?: number;
  };
  ingestion?: {
    workerPoolSize?: number;
    maxFileBytes?: number;
    /**
     * Byte cap for binary documents (PDF, DOCX, ...); default 33554432 (32MB).
     * Separate from `maxFileBytes`, which is sized for source files at 2MB and
     * would refuse most real PDFs.
     */
    maxDocumentBytes?: number;
    /** Pages of a paginated document that are parsed; default 500. */
    maxDocumentPages?: number;
    watchConfirmThreshold?: { projects: number; files: number };
    /**
     * ADR-023 runtime growth bound. `watchConfirmThreshold` asks "is this too
     * much to take on?" at `prag watch`; this asks the same question of a
     * project already being watched, so a directory moved or cloned into one
     * is held rather than silently indexed. `0` on a limit disables it.
     */
    growth?: { windowMs?: number; maxFiles?: number; maxBytes?: number };
    /** ADR-019 bound on POST /sync (ms); default 60000. */
    syncTimeoutMs?: number;
  };
  /**
   * ADR-024: the web fetch backend. Absent means no backend, and every
   * non-`file://` grant is refused -- which is the default and keeps the
   * install local-only. A backend is never selected implicitly.
   */
  web?: {
    /** Backend id, e.g. "crawlberg". Unknown ids fail at startup. */
    backend?: string;
    /**
     * Pages one `prag watch <origin>` will index; default 200. `discover`
     * reports what a site advertises, and an unbounded sitemap would
     * otherwise turn one command into tens of thousands of embeds.
     */
    maxPagesPerSite?: number;
    firecrawl?: { url?: string; apiKey?: string };
    exa?: { apiKey?: string };
    /** Options for the built-in crawlberg backend (see WebBackendConfig). */
    crawlberg?: {
      allowPrivateNetwork?: boolean;
      ignoreRobotsTxt?: boolean;
      rateLimitMs?: number;
      userAgent?: string;
    };
  };
  storage?: {
    dataDir?: string | null;
    runDir?: string | null;
  };
  defaults?: {
    localCooldownSeconds?: number;
    webCooldownSeconds?: number;
    defaultSearchLimit?: number;
    defaultSearchMode?: string;
  };
}

/** Load and parse config.json from the resolved config directory. */
export function loadPragConfig(configDir: string): PragConfig {
  const path = join(configDir, "config.json");
  if (!existsSync(path)) return {};
  // A malformed config.json is a hard error, not a silent default: falling back to
  // `{}` would start the daemon on the wrong port or model with no indication why.
  return JSON.parse(readFileSync(path, "utf-8")) as PragConfig;
}

/**
 * Create the four resolved directories. `resolvePragPaths()` is deliberately pure
 * — a test that resolves paths must not touch the filesystem — so whoever is about
 * to *use* them calls this first.
 *
 * Before this, only `runDir` (daemon start) and `dataDir` (as a side effect of
 * LanceDB connecting) were created, so `configDir` never existed: a user following
 * env-and-storage-paths.md had to `mkdir ~/.config/prag` by hand before `config.json`
 * would be read at all, and the file was silently ignored until they did.
 */
export function ensurePragDirs(paths: PragPaths): void {
  for (const dir of [paths.dataDir, paths.configDir, paths.runDir, paths.logDir]) {
    mkdirSync(dir, { recursive: true });
  }
}
