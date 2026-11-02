// @prag/daemon — Test harness with PRAG_ROOT isolation (ADR-019)
//
// Provides startTestDaemon() and stopTestDaemon() for concurrent-safe
// test setup/teardown.
//
// Two modes. `spawn` is the default and is what the design asks for: a real
// managed child, started exactly the way `prag daemon start` starts one, with
// piped stdio so a failure to boot shows up in test output instead of as a
// timeout. `in-process` constructs a Daemon in this process; it is faster, it
// gives a test direct access to the Daemon and LanceDbSchema objects, and it is
// the only mode that works where subprocess networking is isolated (the scoder
// sandbox this project is developed in). Set PRAG_TEST_MODE=in-process to force
// it for a whole run without editing any test.

import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";

import { LanceDbSchema, FakeEmbeddingProvider } from "@prag/core";
import { Daemon } from "./daemon.js";

/** How the harness runs the daemon. See the file header. */
export type TestDaemonMode = "spawn" | "in-process";

export interface TestDaemonInstance {
  /** Fixture repos, present when started with `withFixtures`. */
  fixtures?: { alpha: string; beta: string; plain: string };
  baseUrl: string;
  port: number;
  token: string;
  root: string;
  mode: TestDaemonMode;
  /**
   * In-process only. Absent under `spawn`, where the daemon is another
   * process — a test that reaches for these is asking for in-process.
   */
  daemon?: Daemon;
  schema?: LanceDbSchema;
  /** Spawn only: the managed child, and whatever it has written to stderr. */
  child?: ChildProcess;
  stderr?: () => string;
}

/**
 * The default mode, overridable per run. A developer on a machine that cannot
 * route loopback to a child process exports PRAG_TEST_MODE=in-process once,
 * rather than every test growing a conditional.
 */
export function defaultTestMode(): TestDaemonMode {
  return process.env.PRAG_TEST_MODE === "in-process" ? "in-process" : "spawn";
}

/**
 * Build git fixture repositories into a directory under root.
 * Returns paths for each fixture repo.
 */
export function buildFixtures(root: string): { alpha: string; beta: string; plain: string } {
  const builderPath = resolve(
    import.meta.dirname!,
    "..", "..", "..", "test", "fixtures", "build-git-fixtures.mjs",
  );
  const targetDir = join(root, "fixtures");
  const stdout = execFileSync(process.execPath, [builderPath, targetDir], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(stdout.trim()) as { alpha: string; beta: string; plain: string };
}

/**
 * Poll `GET /health` until the daemon answers, then refuse to hand back a
 * daemon that is not rooted in this test's temp directory.
 *
 * The failure is deliberately loud and takes the daemon down with it: a test
 * that proceeds against the developer's real `~/.local/share/prag` can delete
 * their index.
 */
async function assertReady(
  baseUrl: string,
  expectedRoot: string,
  daemon?: Daemon,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "no response";
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      const body = (await res.json()) as { status?: string; root?: string | null };
      if (body.status === "ok") {
        if (body.root !== expectedRoot) {
          await daemon?.stop().catch(() => {});
          throw new Error(
            `test daemon is rooted at ${JSON.stringify(body.root)}, expected ` +
              `${JSON.stringify(expectedRoot)} -- refusing to run a test against ` +
              "an index that is not the throwaway one (ADR-019)",
          );
        }
        return;
      }
      last = `status ${JSON.stringify(body.status)}`;
    } catch (err) {
      if (err instanceof Error && err.message.includes("refusing to run")) throw err;
      last = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() > deadline) {
      await daemon?.stop().catch(() => {});
      throw new Error(`test daemon was not ready within ${timeoutMs}ms (last: ${last})`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}


/** Resolve the daemon entry the same way `prag daemon start` does. */
function daemonEntry(): { entry: string; args: string[] } {
  const source = resolve(import.meta.dirname!, "main.ts");
  if (existsSync(source)) return { entry: source, args: ["--import", "tsx", source] };
  const built = resolve(import.meta.dirname!, "..", "dist", "main.js");
  return { entry: built, args: [built] };
}

/**
 * Start the daemon as a managed child, the way the design describes it
 * (ADR-019): not detached, stdio piped so a boot failure is visible, and the
 * port read back from `daemon.port` rather than guessed — PRAG_PORT=0 means the
 * kernel chooses it and only the daemon knows which.
 */
async function startSpawned(opts: {
  root: string;
  token: string;
  port: number;
  dim: number;
  withFixtures?: boolean;
}): Promise<TestDaemonInstance> {
  const { root, token, port, dim } = opts;
  const { args } = daemonEntry();

  const child = spawn(process.execPath, args, {
    // Managed, not detached: a crashed test must not leave a daemon holding a
    // port and a temp directory.
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PRAG_ROOT: root,
      PRAG_PORT: String(port),
      PRAG_API_KEY: token,
      // Offline and deterministic: the real embedder would download 130MB
      // before the first test could run (ADR-019).
      PRAG_EMBEDDING_MODEL: `fake:${dim}`,
      PRAG_DEBOUNCE_MS: "0",
      // The daemon must never lazily spawn a second one.
      PRAG_NO_SPAWN: "1",
      PRAG_TEST_MODE: "",
    },
  });

  let captured = "";
  child.stderr?.on("data", (d: Buffer) => { captured += d.toString(); });
  child.stdout?.on("data", (d: Buffer) => { captured += d.toString(); });
  const stderr = () => captured;

  let exited: { code: number | null; signal: string | null } | null = null;
  child.once("exit", (code, signal) => { exited = { code, signal }; });

  const fail = async (why: string): Promise<never> => {
    child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
    // The child's own output is the only explanation of a boot failure, so it
    // goes in the message rather than being lost with the process.
    throw new Error(`${why}\n--- daemon output ---\n${captured || "(none)"}`);
  };

  // PRAG_PORT=0 binds an ephemeral port; writeRuntimeFiles() records the real
  // one. Polling the file is how a client is meant to find a daemon (ADR-016),
  // so the harness uses the documented path rather than a private channel.
  const portFile = join(root, "state", "daemon.port");
  const deadline = Date.now() + 20_000;
  let boundPort = 0;
  while (Date.now() < deadline) {
    if (exited) await fail(`the daemon exited before binding a port (${JSON.stringify(exited)})`);
    if (existsSync(portFile)) {
      const raw = readFileSync(portFile, "utf-8").trim();
      if (raw && Number(raw) > 0) { boundPort = Number(raw); break; }
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  if (boundPort === 0) await fail("the daemon never wrote state/daemon.port");

  const baseUrl = `http://127.0.0.1:${boundPort}`;
  try {
    await assertReady(baseUrl, root);
  } catch (err) {
    await fail(err instanceof Error ? err.message : String(err));
  }

  const fixtures = opts.withFixtures ? buildFixtures(root) : undefined;
  return { baseUrl, port: boundPort, token, root, mode: "spawn", child, stderr, fixtures };
}

/**
 * Start a test daemon with full PRAG_ROOT isolation (ADR-019).
 * Each call gets its own temp root.
 * Safe to call concurrently.
 */
export async function startTestDaemon(
  overrides?: {
    port?: number;
    token?: string;
    embeddingDim?: number;
    withFixtures?: boolean;
    /** Defaults to `spawn`, or PRAG_TEST_MODE when set. */
    mode?: TestDaemonMode;
  },
): Promise<TestDaemonInstance & { fixtures?: { alpha: string; beta: string; plain: string } }> {
  const root = mkdtempSync(join(tmpdir(), "prag-harness-"));
  const token = overrides?.token ?? "test-token";
  const port = overrides?.port ?? 0; // 0 = OS-assigned
  const dim = overrides?.embeddingDim ?? 4;
  const mode = overrides?.mode ?? defaultTestMode();

  if (mode === "spawn") {
    return startSpawned({ root, token, port, dim, withFixtures: overrides?.withFixtures });
  }

  const schema = new LanceDbSchema({
    dbPath: root,
    embeddingDim: dim,
    maxVectorUnitTokens: 512,
    modelMaxSeqLength: 512,
  });
  await schema.init();

  // Paths are passed explicitly, never through process.env. The harness is
  // required to be safe to run concurrently (ADR-019), and `process.env` is
  // shared global state: the previous version set PRAG_ROOT, awaited
  // daemon.start() -- which yields -- and then restored the old value, so two
  // overlapping startTestDaemon calls could restore over each other and hand a
  // later daemon another test's root.
  const daemon = new Daemon({
    port: port || undefined,
    token,
    noExit: true,
    paths: {
      root,
      dataDir: join(root, "data"),
      configDir: join(root, "config"),
      runDir: join(root, "state"),
      logDir: join(root, "state", "logs"),
    },
  });

  await daemon.start(schema, new FakeEmbeddingProvider(dim));

  const boundPort = daemon.boundPort ?? port;
  const baseUrl = `http://127.0.0.1:${boundPort}`;

  // Readiness, then the isolation assertion (ADR-019). Returning before the
  // daemon answers makes the first request in a test a race; returning when it
  // is serving the WRONG root is worse, because the next call may be
  // destructive against a real index. Both are the harness's job, not each
  // test's.
  await assertReady(baseUrl, root, daemon);

  let fixtures: { alpha: string; beta: string; plain: string } | undefined;
  if (overrides?.withFixtures) {
    fixtures = buildFixtures(root);
  }

  return { baseUrl, port: boundPort, token, root, mode, daemon, schema, fixtures };
}

/**
 * Stop a test daemon and clean up.
 * Safe to call after a failed test.
 */
export async function stopTestDaemon(instance: TestDaemonInstance): Promise<void> {
  const { root, daemon, schema, child } = instance;

  if (child) {
    // Ask politely, then insist. Teardown has to run after a failed test too,
    // so nothing here may throw and nothing may wait forever.
    try {
      await fetch(`${instance.baseUrl}/shutdown`, {
        method: "POST",
        headers: { Authorization: `Bearer ${instance.token}` },
      });
    } catch {
      // Already gone, or never answered — SIGKILL below covers it.
    }
    const exited = await new Promise<boolean>((done) => {
      if (child.exitCode !== null || child.signalCode !== null) return done(true);
      const timer = setTimeout(() => done(false), 5_000);
      child.once("exit", () => { clearTimeout(timer); done(true); });
    });
    if (!exited) {
      child.kill("SIGKILL");
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  try {
    await daemon?.stop();
  } catch {
    // Already stopped
  }

  try {
    await schema?.close();
  } catch {
    // Already closed
  }

  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Already removed
  }
}
