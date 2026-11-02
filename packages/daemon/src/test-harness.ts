// @prag/daemon — Test harness with PRAG_ROOT isolation (ADR-019)
//
// Provides startTestDaemon() and stopTestDaemon() for concurrent-safe
// test setup/teardown. Starts the daemon in-memory (no subprocess
// since no CLI entry point exists yet).

import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { LanceDbSchema, FakeEmbeddingProvider } from "@prag/core";
import { Daemon } from "./daemon.js";

export interface TestDaemonInstance {
  /** Fixture repos, present when started with `withFixtures`. */
  fixtures?: { alpha: string; beta: string; plain: string };
  baseUrl: string;
  port: number;
  token: string;
  root: string;
  daemon: Daemon;
  schema: LanceDbSchema;
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
  daemon: Daemon,
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
          await daemon.stop().catch(() => {});
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
      await daemon.stop().catch(() => {});
      throw new Error(`test daemon was not ready within ${timeoutMs}ms (last: ${last})`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
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
  },
): Promise<TestDaemonInstance & { fixtures?: { alpha: string; beta: string; plain: string } }> {
  const root = mkdtempSync(join(tmpdir(), "prag-harness-"));
  const token = overrides?.token ?? "test-token";
  const port = overrides?.port ?? 0; // 0 = OS-assigned
  const dim = overrides?.embeddingDim ?? 4;

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

  return { baseUrl, port: boundPort, token, root, daemon, schema, fixtures };
}

/**
 * Stop a test daemon and clean up.
 * Safe to call after a failed test.
 */
export async function stopTestDaemon(instance: TestDaemonInstance): Promise<void> {
  const { root, daemon, schema } = instance;

  try {
    await daemon.stop();
  } catch {
    // Already stopped
  }

  try {
    await schema.close();
  } catch {
    // Already closed
  }

  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Already removed
  }
}
