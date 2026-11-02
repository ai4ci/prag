// @prag/core — Path resolution with PRAG_ROOT isolation (ADR-019)
//
// Precedence per category:
//   1. explicit PRAG_DATA_DIR / PRAG_CONFIG_DIR / PRAG_RUN_DIR / PRAG_LOG_DIR
//   2. derived from PRAG_ROOT (<root>/data, <root>/config, <root>/state, <root>/state/logs)
//   3. XDG / platform default
//
// When PRAG_ROOT is set, an unset category never falls back to XDG.

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
    watchConfirmThreshold?: { projects: number; files: number };
    /** ADR-019 bound on POST /sync (ms); default 60000. */
    syncTimeoutMs?: number;
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
  try {
    const { readFileSync, existsSync } = require("node:fs") as typeof import("node:fs");
    const path = join(configDir, "config.json");
    if (!existsSync(path)) return {};
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as PragConfig;
  } catch {
    return {};
  }
}
