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
  ensurePragDirs,
  resolvePragPaths,
  DEFAULT_MAX_VECTOR_UNIT_TOKENS,
  type EmbeddingProvider,
  type PragConfig,
  type PragPaths,
  resolveWebBackend,
} from "@prag/core";
import { join } from "node:path";
import { writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { Daemon, type DaemonConfig } from "./daemon.js";
// Imported for its side effect: registering the crawlberg backend, so that
// `web.backend: "crawlberg"` resolves. The import lives in the daemon entry
// point and nowhere else, which is what keeps the native addon off the CLI's
// graph (ADR-020).
import "./crawlberg-backend.js";

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
/** Integer env var, or undefined when unset/unparseable (so `??` can chain). */
function readIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export function loadConfig(): DaemonConfig {
  const paths = resolvePragPaths();
  // Before reading config.json: nothing else creates configDir, so on a fresh
  // machine the documented config file was never picked up (and logDir never
  // existed either). Idempotent.
  ensurePragDirs(paths);
  const config = loadPragConfig(paths.configDir);

  // `??`, not `||`: PRAG_PORT=0 means "let the kernel choose and report the
  // bound port in state/daemon.port" (ADR-019), and `0 || ...` discarded it, so
  // every test daemon silently took the fixed default and two could not run at
  // once. readIntEnv already distinguishes unset from zero -- this line simply
  // was not using it.
  const port = readIntEnv("PRAG_PORT") ?? config.server?.port ?? DEFAULT_PORT;
  const token = process.env.PRAG_API_KEY ?? "guest";

  // ADR-024: exactly one backend, or none. An unknown id throws here, before
  // the port is bound, so a typo is a startup failure naming the valid ids
  // rather than a silent fallback to a different egress path.
  const webBackend = resolveWebBackend(
    process.env.PRAG_WEB_BACKEND?.trim() || config.web?.backend,
    { firecrawl: config.web?.firecrawl, exa: config.web?.exa, crawlberg: config.web?.crawlberg },
  );

  return {
    port,
    token,
    webBackend,
    webMaxPagesPerSite: config.web?.maxPagesPerSite,
    webCooldownSeconds: config.defaults?.webCooldownSeconds,
    paths,
    ingestion: {
      // Explicit 0 disables watching; otherwise the configured size, then 1.
      // `??`, not `||`: with `||` the documented "0 disables" was unreachable from
      // either knob -- 0 is falsy, so config.json fell through to DEFAULT_POOL_SIZE
      // and PRAG_WORKER_POOL_SIZE=0 did too.
      poolSize:
        readIntEnv("PRAG_WORKER_POOL_SIZE") ??
        config.ingestion?.workerPoolSize ??
        DEFAULT_POOL_SIZE,
      maxFileBytes: config.ingestion?.maxFileBytes,
      cooldownMs: process.env.PRAG_DEBOUNCE_MS
        ? Number(process.env.PRAG_DEBOUNCE_MS)
        : config.server?.debounceMs,
      syncTimeoutMs: process.env.PRAG_SYNC_TIMEOUT_MS
        ? Number(process.env.PRAG_SYNC_TIMEOUT_MS)
        : config.ingestion?.syncTimeoutMs,
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
 * ADR-015 §3: perform a re-embed rebuild and hand the daemon fresh handles.
 *
 * Lives here rather than in the daemon because it is the only place that knows
 * how to resolve a model id to a provider and how to size the ADR-014 window.
 * It is deliberately usable with no live database: a daemon running degraded
 * after a model mismatch has neither, and `/reembed` is the documented way out
 * of exactly that state.
 */
export async function rebuildEmbeddingSpace(
  config: DaemonConfig,
  existing: LanceDbSchema | null,
  modelId?: string,
): Promise<{ schema: LanceDbSchema; provider: EmbeddingProvider; maxVectorUnitTokens: number }> {
  const paths = config.paths ?? resolvePragPaths();
  const dbPath = dbPathFor(paths);

  // An explicit --model wins; otherwise rebuild under whatever is configured,
  // which is the mismatch case: the index is stale, the config is right.
  const provider = resolveEmbeddingModel(modelId ?? embeddingModelId(config));
  await provider.load?.();

  const maxTokens =
    config.maxVectorUnitTokens ??
    Math.min(DEFAULT_MAX_VECTOR_UNIT_TOKENS, provider.maxSeqLength);
  // Before anything is dropped: refusing here leaves the old index intact,
  // whereas refusing after the drop would destroy it for a config that cannot
  // start anyway (ADR-014).
  assertVectorUnitBudget(maxTokens, provider.maxSeqLength);

  // The drop needs a connection. In degraded mode there is none, so open a
  // throwaway schema at the *old* dimension purely to drop the content tables;
  // its own vector_pool definition is irrelevant because that table is going.
  const opener = existing ?? new LanceDbSchema({ dbPath });
  if (!existing) await opener.init();
  await opener.dropContentTables();
  await opener.close();

  // Reopened at the new dimension. The content tables no longer exist, so
  // init() recreates them to the new schema; grants and projects are untouched.
  const schema = new LanceDbSchema({
    dbPath,
    embeddingDim: provider.dim,
    maxVectorUnitTokens: maxTokens,
    modelMaxSeqLength: provider.maxSeqLength,
  });
  await schema.init();

  // Pinned only once the new space exists: a sidecar written before the drop
  // would describe an index that failed to rebuild (ADR-015 §5).
  writeEmbeddingSidecar(dbPath, {
    model: provider.model,
    dim: provider.dim,
    maxSeqLength: provider.maxSeqLength,
    pinnedAt: new Date().toISOString(),
  });

  return { schema, provider, maxVectorUnitTokens: maxTokens };
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
  const dbPath = dbPathFor(paths);

  // Before load(): the sidecar comparison needs only the model id, and a user
  // who is about to be told "this index was built with another model" must not
  // first watch 130MB of weights download for a run that cannot serve them.
  const sidecar = readEmbeddingSidecar(dbPath);
  if (sidecar && sidecar.model !== provider.model && !options.allowMismatch) {
    throw new EmbeddingMismatchError(sidecar.model, provider.model, dbPath);
  }

  await provider.load?.();

  const maxTokens =
    config.maxVectorUnitTokens ??
    Math.min(DEFAULT_MAX_VECTOR_UNIT_TOKENS, provider.maxSeqLength);
  assertVectorUnitBudget(maxTokens, provider.maxSeqLength);

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
  // `current` tracks the live schema so a second reembed drops through the
  // handle the first one left behind, not the stale one captured here.
  let current: LanceDbSchema = schema;
  await daemon.start(schema, provider, {
    maxVectorUnitTokens: maxTokens,
    vectorUnitOverlapTokens: config.vectorUnitOverlapTokens,
    embeddingBatchSize: config.batchSize,
    rebuild: async (id) => {
      const next = await rebuildEmbeddingSpace(config, current, id);
      current = next.schema;
      return next;
    },
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
      // The hook is the whole point of staying up: without it /reembed answers
      // 503 and the mismatch is unescapable without deleting the data directory
      // by hand. `null` because degraded mode holds no open database.
      let rebuilt: LanceDbSchema | null = null;
      await degraded.start(null, null, {
        mismatch: err,
        vectorUnitOverlapTokens: config.vectorUnitOverlapTokens,
        embeddingBatchSize: config.batchSize,
        rebuild: async (id) => {
          const next = await rebuildEmbeddingSpace(config, rebuilt, id);
          rebuilt = next.schema;
          return next;
        },
      });
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

  // The execution provider is named on startup because it is the difference
  // between "slow" and "broken acceleration", and nothing else surfaces it
  // before the first embed (task:local-first-enforcement.md).
  const device =
    (startup.provider as { activeDevice?: string | null }).activeDevice ?? "cpu";
  console.log(
    `[prag] daemon listening on 127.0.0.1:${port} ` +
      `(root: ${paths.root || "xdg"}, model: ${startup.provider.model}, ` +
      `dim: ${startup.provider.dim}, device: ${device})`,
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
  main().catch((err: unknown) => {
    // The one startup failure a user can act on. The CLI makes the same promise
    // when it probes the port (cli-and-mcp-interface.md §Port Identity), so the
    // daemon must not answer with a bare stack trace.
    if ((err as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
      const port = (err as { port?: number }).port ?? "?";
      console.error(
        `Port ${port} is in use by a different process. Set PRAG_PORT or server.port ` +
          "in config.json to use a different port, or stop the conflicting process.",
      );
      process.exit(1);
    }
    console.error("[prag] fatal:", err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}
