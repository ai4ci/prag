// @prag/daemon — ADR-009 §3: each git repository under a watched root is its
// own project.
//
// Discovery counted child repositories and discarded the paths, so `watch`
// wrote a single `projects` row covering the whole tree: per-repository
// scoping did not exist, and a search could not be confined to one repo.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { LanceDbSchema, FakeEmbeddingProvider } from "@prag/core";
import { Daemon } from "../src/daemon.js";
import { WorkerPool } from "../src/worker-pool.js";
import { IngestionQueue } from "../src/ingestion-queue.js";

const WORKER_SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)), "../src/ingestion-worker.ts");

const TOKEN = "test-child-repos";
const HEADERS = { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };

async function json(port: number, path: string, body?: unknown, method = "POST") {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: HEADERS,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let parsed: unknown = null;
  try { parsed = JSON.parse(await res.text()); } catch { /* non-JSON */ }
  return { status: res.status, body: parsed as Record<string, any> };
}

function makeRepo(dir: string, file: string, contents: string): string {
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(dir, file), contents);
  return dir;
}

function childRepoSuite(): void {
  const ctx: { tmpDir: string; schema: LanceDbSchema | null; daemon: Daemon | null; port: number } =
    { tmpDir: "", schema: null, daemon: null, port: 0 };
  let root = "";
  let child = "";

  before(async () => {
    ctx.tmpDir = mkdtempSync(join(tmpdir(), "prag-child-repos-"));
    ctx.schema = new LanceDbSchema({
      dbPath: join(ctx.tmpDir, "lancedb"),
      embeddingDim: 4,
      maxVectorUnitTokens: 512,
      modelMaxSeqLength: 512,
    });
    await ctx.schema.init();
    ctx.daemon = new Daemon({
      port: 0,
      token: TOKEN,
      noExit: true,
      ingestion: { poolSize: 1, cooldownMs: 10 },
    });
    await ctx.daemon.start(ctx.schema, new FakeEmbeddingProvider(4));
    ctx.port = ctx.daemon.boundPort!;

    root = makeRepo(join(ctx.tmpDir, "monorepo"), "root-only.ts", "export const root = 1;\n");
    child = makeRepo(join(root, "packages", "child"), "child-only.ts", "export const child = 2;\n");
  });

  after(async () => {
    await ctx.daemon?.stop();
    await ctx.schema?.close();
    rmSync(ctx.tmpDir, { recursive: true, force: true });
  });

  void it("registers the root and every child repository as separate projects", async () => {
    const res = await json(ctx.port, "/projects/watch", { uri: `file://${root}`, projectId: "mono" });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    // Both ids come back, so a caller can scope to the child without first
    // listing the registry.
    assert.deepEqual(res.body.registered, ["mono", child]);

    const projects = await json(ctx.port, "/projects", undefined, "GET");
    const ids = (projects.body as Array<{ projectId: string }>).map((p) => p.projectId).sort();
    assert.deepEqual(ids, ["mono", child].sort(),
      "the child repository did not get its own projects row");
  });

  void it("keeps the child repo's files out of the parent's ingestion queue", async () => {
    // Only the parent is registered, deliberately. `IngestionQueue.dirty` is
    // keyed by uri alone (`_onEvent`), so when both projects watch the same
    // file the last watcher to report simply overwrites the first: exactly one
    // ingestion happens either way and the owning projectId is decided by event
    // ordering. That collapse hides the exclusion, and an earlier version of
    // this test passed with the mechanism removed. With the parent alone there
    // is nothing to overwrite, so the exclusion is the only thing that can keep
    // the child's file out.
    const pool = new WorkerPool(1, WORKER_SCRIPT);
    const ingested: Array<{ projectId: string; filePath: string }> = [];
    const queue = new IngestionQueue(pool, (r) => { ingested.push(r); }, { cooldownMs: 10 });
    try {
      queue.registerProject("parent", root, 10, [child]);
      await queue.scanComplete();
      await queue.flushAll();

      const files = ingested.map((r) => r.filePath);
      assert.ok(
        !files.some((f) => f.endsWith("child-only.ts")),
        `the parent ingested the child repo's file: ${JSON.stringify(files)}`,
      );
      assert.ok(
        files.some((f) => f.endsWith("root-only.ts")),
        `the exclusion also suppressed the parent's own file: ${JSON.stringify(files)}`,
      );
    } finally {
      await queue.close();
      await pool.close();
    }
  });

}

void describe("watch — child git repositories", childRepoSuite);
