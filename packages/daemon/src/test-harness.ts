// @prag/daemon — Test harness with PRAG_ROOT isolation (ADR-019)
//
// Provides startTestDaemon() and stopTestDaemon() for concurrent-safe
// test setup/teardown. Starts the daemon in-memory (no subprocess
// since no CLI entry point exists yet).

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { LanceDbSchema, FakeEmbeddingProvider } from "@prag/core";
import { Daemon } from "./daemon.js";

export interface TestDaemonInstance {
  baseUrl: string;
  port: number;
  token: string;
  root: string;
  daemon: Daemon;
  schema: LanceDbSchema;
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
  },
): Promise<TestDaemonInstance> {
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

  // Set env so Daemon's resolvePragPaths() picks up the isolation root
  const prevRoot = process.env.PRAG_ROOT;
  process.env.PRAG_ROOT = root;

  const daemon = new Daemon({
    port: port || undefined,
    token,
  });

  await daemon.start(schema, new FakeEmbeddingProvider(dim));

  // Restore previous PRAG_ROOT if any (isolate concurrent tests)
  if (prevRoot === undefined) delete process.env.PRAG_ROOT;
  else process.env.PRAG_ROOT = prevRoot;

  const boundPort = daemon.boundPort ?? port;
  const baseUrl = `http://127.0.0.1:${boundPort}`;

  return { baseUrl, port: boundPort, token, root, daemon, schema };
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
