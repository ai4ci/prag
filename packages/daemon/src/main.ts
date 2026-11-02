// @prag/daemon — executable entry point (task:daemon-http-server-and-lifecycle)
//
// This file is what `prag daemon start` spawns. It owns the startup sequence
// that `Daemon` deliberately does not: resolve paths, read config, choose the
// embedding provider, verify the index's embedding space (ADR-015), size the
// ADR-014 window against the model's own ceiling, then open the database.
//
// `Daemon` takes an already-built schema + provider so tests can inject a fake
// without dragging 775MB of ONNX deps into the suite (ADR-019).

import {
  assertVectorUnitBudget,
  DEFAULT_EMBEDDING_MODEL,
  LanceDbSchema,
  readEmbeddingSidecar,
  resolveEmbeddingModel,
  writeEmbeddingSidecar,
  loadPragConfig,
  resolvePragPaths,
  DEFAULT_MAX_VECTOR_UNIT_TOKENS,
  type EmbeddingProvider,
  type PragConfig,
  type PragPaths,
} from "@prag/core";
import { join } from "node:path";
import { writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { Daemon, type DaemonConfig } from "./daemon.js";

// ── Database location ────────────────────────────────────────────────

/** LanceDB lives in its own subdirectory (env-and-storage-paths.md §2). */
export function dbPathFor(paths: PragPaths): string {
  return join(paths.dataDir, "lancedb");
}

// ── Config ────────────────────────────────────────────────────────────

const DEFAULT_PORT = 7724;
const DEFAULT_POOL_SIZE = 1;

/**
 * Resolve daemon config from env + config.json.
 *
 * Env wins over the file: the CLI passes PRAG_PORT when spawning, and
 * PRAG_API_KEY is the documented auth knob (ADR-013).
 */
export function loadConfig(): DaemonConfig {
  const paths = resolvePragPaths();
  const config = loadPragConfig(paths.configDir);

  const port =
    Number(process.env.PRAG_PORT) || config.server?.port || DEFAULT_PORT;
  const token = process.env.PRAG_API_KEY ?? "guest";

  return {
    port,
    token,
    paths,
    ingestion: {
      // Explicit 0 disables watching; otherwise the configured size, then 1.
      poolSize:
        Number(process.env.PRAG_WORKER_POOL_SIZE) ||
        config.ingestion?.workerPoolSize ||
        DEFAULT_POOL_SIZE,
      maxFileBytes: config.ingestion?.maxFileBytes,
      cooldownMs: config.server?.debounceMs,
    },
    embeddingModel: process.env.PRAG_EMBEDDING_MODEL || config.embedding?.model,
    maxVectorUnitTokens: config.embedding?.maxVectorUnitTokens,
    vectorUnitOverlapTokens: config.embedding?.vectorUnitOverlapTokens,
    batchSize: config.embedding?.batchSize,
  };
}

/** The model this daemon will embed with. */
export function embeddingModelId(config: PragConfig | DaemonConfig): string {
  return (
    (config as DaemonConfig).embeddingModel ||
    (config as PragConfig).embedding?.model ||
    DEFAULT_EMBEDDING_MODEL
  );
}

// ── Startup ───────────────────────────────────────────────────────────

export interface Startup {
  daemon: Daemon;
  schema: LanceDbSchema;
  provider: EmbeddingProvider;
  config: DaemonConfig;
}

/**
 * Build every runtime dependency. Throws (before binding a port) when:
 *  - the configured ADR-014 window cannot fit the model's ceiling, or
 *  - an existing index was built by a different embedding model (ADR-015).
 *
 * `allowMismatch` skips the second check; that is how `/reembed` can be served
 * while the index is stale.
 */
export async function bootstrap(
  config: DaemonConfig,
  options: { allowMismatch?: boolean } = {},
): Promise<Startup> {
  const paths = config.paths ?? resolvePragPaths();
  const modelId = embeddingModelId(config);

  // resolveEmbeddingModel loads no weights; OnnxEmbeddingProvider defers until
  // first use, but dim/maxSeqLength are unknown until then.
  const provider = resolveEmbeddingModel(modelId);
  await provider.load?.();

  const maxTokens =
    config.maxVectorUnitTokens ??
    Math.min(DEFAULT_MAX_VECTOR_UNIT_TOKENS, provider.maxSeqLength);
  assertVectorUnitBudget(maxTokens, provider.maxSeqLength);

  const dbPath = dbPathFor(paths);
  const sidecar = readEmbeddingSidecar(dbPath);
  if (sidecar && sidecar.model !== provider.model && !options.allowMismatch) {
    throw new EmbeddingMismatchError(sidecar.model, provider.model, dbPath);
  }

  const schema = new LanceDbSchema({
    dbPath,
    embeddingDim: provider.dim,
    maxVectorUnitTokens: maxTokens,
    modelMaxSeqLength: provider.maxSeqLength,
  });
  await schema.init();

  // First run (or after a successful reembed): record what this index is.
  if (!sidecar || sidecar.model !== provider.model) {
    writeEmbeddingSidecar(dbPath, {
      model: provider.model,
      dim: provider.dim,
      maxSeqLength: provider.maxSeqLength,
      pinnedAt: new Date().toISOString(),
    });
  }

  const daemon = new Daemon(config);
  await daemon.start(schema, provider, {
    maxVectorUnitTokens: maxTokens,
    vectorUnitOverlapTokens: config.vectorUnitOverlapTokens,
    embeddingBatchSize: config.batchSize,
  });

  return { daemon, schema, provider, config };
}

export class EmbeddingMismatchError extends Error {
  constructor(
    readonly indexModel: string,
    readonly requestedModel: string,
    readonly dbPath: string,
  ) {
    super(
      `Index at ${dbPath} was built with "${indexModel}" but the active model is ` +
        `"${requestedModel}". Rebuilding is required: run \`prag reembed --model ` +
        `${requestedModel}\` (ADR-015). Set PRAG_EMBEDDING_MODEL to the original ` +
        `model to serve the index as-is.`,
    );
    this.name = "EmbeddingMismatchError";
  }
}

// ── Runtime state files ───────────────────────────────────────────────

/**
 * Write `daemon.port` (always) and `daemon.token` (0600, only when the token is
 * the default "guest", per env-and-storage-paths.md). The CLI reads the port
 * file to find a daemon it did not spawn itself.
 */
export function writeRuntimeFiles(
  paths: PragPaths,
  port: number,
  token: string,
): void {
  // Nothing else creates runDir; LanceDB only makes its own data directory.
  mkdirSync(paths.runDir, { recursive: true });
  writeFileSync(join(paths.runDir, "daemon.port"), String(port));
  if (token === "guest") {
    const tokenPath = join(paths.runDir, "daemon.token");
    writeFileSync(tokenPath, token, { mode: 0o600 });
    try {
      chmodSync(tokenPath, 0o600);
    } catch {
      /* already 0600 or a platform that ignores mode */
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = loadConfig();

  let startup: Startup;
  try {
    startup = await bootstrap(config);
  } catch (err) {
    if (err instanceof EmbeddingMismatchError) {
      // ADR-015: stay up but serve only /health, /reembed and /shutdown, so the
      // user has a way to fix the index instead of a daemon that exits.
      console.error(`[prag] ${err.message}`);
      const degraded = new Daemon(config);
      await degraded.start(null, null, { mismatch: err });
      writeRuntimeFiles(
        config.paths ?? resolvePragPaths(),
        degraded.boundPort ?? config.port ?? 0,
        config.token ?? "guest",
      );
      installShutdown(degraded, config);
      return;
    }
    throw err;
  }

  const { daemon, config: cfg } = startup;
  const paths = cfg.paths ?? resolvePragPaths();
  const port = daemon.boundPort ?? cfg.port ?? 0;
  writeRuntimeFiles(paths, port, cfg.token ?? "guest");
  installShutdown(daemon, cfg);

  console.log(
    `[prag] daemon listening on 127.0.0.1:${port} ` +
      `(root: ${paths.root || "xdg"}, model: ${startup.provider.model}, dim: ${startup.provider.dim})`,
  );
}

function installShutdown(daemon: Daemon, config: DaemonConfig): void {
  let closing = false;
  const close = (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`[prag] ${signal}: draining ingestion and closing`);
    daemon
      .stop()
      .catch((err) => console.error("[prag] shutdown error:", err))
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", () => close("SIGINT"));
  process.on("SIGTERM", () => close("SIGTERM"));
  void config;
}

// Only run when executed directly — importing this module (tests, the CLI's
// health probe) must not bind a port.
const invokedDirectly =
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error("[prag] fatal:", err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}
