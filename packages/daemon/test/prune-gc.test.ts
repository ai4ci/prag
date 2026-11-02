// @prag/daemon — prune vs. the opt-in chunk GC (task:branch-mapping-and-pruning.md, ADR-017)
//
// chunks_pool and vector_pool are content-addressed and shared across every file,
// project and branch that ever held that text, so deleting a file must NOT reclaim
// its vectors: only the explicit sweep may. That distinction is the whole content
// of this file — a prune that quietly reclaimed pool rows would silently degrade
// every other project's index.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { LanceDbSchema, FakeEmbeddingProvider } from "@prag/core";
import { Daemon } from "../src/daemon.js";

const TOKEN = "test-prune";
const HEADERS = { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };

void describe("prune and --gc-chunks", () => {
  const ctx: {
    tmp: string;
    repo: string;
    schema: LanceDbSchema | null;
    daemon: Daemon | null;
    port: number;
  } = { tmp: "", repo: "", schema: null, daemon: null, port: 0 };

  const post = async (path: string, body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };

  const count = async (table: string) =>
    (await ctx.schema!.table(table).query().limit(100000).toArray()).length;

  /** Deletions reach the index through the watcher, not through /sync. */
  async function waitUntil(label: string, probe: () => Promise<boolean>): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (await probe()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.fail(`timed out waiting for: ${label}`);
  }

  before(async () => {
    ctx.tmp = mkdtempSync(join(tmpdir(), "prag-prune-"));
    ctx.repo = join(ctx.tmp, "repo");
    mkdirSync(ctx.repo, { recursive: true });
    ctx.schema = new LanceDbSchema({ dbPath: ctx.tmp, embeddingDim: 4 });
    await ctx.schema.init();
    ctx.daemon = new Daemon({
      port: 0,
      token: TOKEN,
      noExit: true,
      ingestion: { poolSize: 1, cooldownMs: 20 },
    });
    await ctx.daemon.start(ctx.schema, new FakeEmbeddingProvider(4));
    ctx.port = ctx.daemon.boundPort!;

    const reg = await post("/projects", { projectId: "repo", rootUri: ctx.repo });
    assert.equal(reg.status, 200, JSON.stringify(reg.json));
  });

  after(async () => {
    await ctx.daemon?.stop();
    await ctx.schema?.close();
    if (ctx.tmp) rmSync(ctx.tmp, { recursive: true, force: true });
    await new Promise((r) => setImmediate(r));
  });

  void it("keeps pool rows on prune, and reclaims them only when asked", async () => {
    writeFileSync(join(ctx.repo, "only.ts"), "export const greeting = 'shared text';\n");
    for (let i = 0; i < 8; i++) {
      const { json } = await post("/sync", { projectId: "repo" });
      if (json.ok && json.pendingFiles === 0) break;
    }
    assert.ok((await count("chunks_pool")) > 0, "fixture must have pool rows");
    assert.ok((await count("vector_pool")) > 0, "fixture must have vectors");
    const pool = await count("chunks_pool");
    assert.equal(await count("vector_pool"), pool, "one vector set per pooled chunk");

    rmSync(join(ctx.repo, "only.ts"));
    await waitUntil(
      "the unlink retires the file version",
      async () => (await count("chunk_mapping")) === 0,
    );

    // Plain prune: the pointers go, the shared content stays (issue:
    // unlink-prune-deletes-shared-pool-rows — another project may hold the same text).
    const plain = await post("/prune", {});
    assert.equal(plain.status, 200, JSON.stringify(plain.json));
    assert.equal(plain.json.gcChunks, false);
    assert.equal(plain.json.purgedChunks, 0, JSON.stringify(plain.json));
    assert.equal(await count("chunks_pool"), pool, "prune must not reclaim shared pool rows");
    assert.equal(await count("vector_pool"), pool, "nor their vectors");

    // The explicit sweep is what reclaims them — and it takes both tables.
    const gc = await post("/prune", { gcChunks: true });
    assert.equal(gc.status, 200, JSON.stringify(gc.json));
    assert.equal(gc.json.purgedChunks, pool, JSON.stringify(gc.json));
    assert.equal(await count("chunks_pool"), 0, "the orphaned chunks are gone");
    assert.equal(await count("vector_pool"), 0, "and their vectors went with them");
  });

  void it("leaves referenced chunks alone while sweeping", async () => {
    writeFileSync(join(ctx.repo, "keep.ts"), "export const greeting = 'still here';\n");
    for (let i = 0; i < 8; i++) {
      const { json } = await post("/sync", { projectId: "repo" });
      if (json.ok && json.pendingFiles === 0) break;
    }
    const referenced = await count("chunks_pool");
    assert.ok(referenced > 0);

    const gc = await post("/prune", { gcChunks: true });
    assert.equal(gc.json.purgedChunks, 0, JSON.stringify(gc.json));
    assert.equal(
      await count("chunks_pool"),
      referenced,
      "a chunk a live file points at survives the sweep",
    );

    const search = await post("/search", { query: "greeting", projectId: "repo", mode: "vector" });
    assert.ok(
      search.json.hits.some((h: any) => String(h.uri).endsWith("keep.ts")),
      `sweeping broke a live file: ${JSON.stringify(search.json.hits)}`,
    );
  });
});
