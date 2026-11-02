// @prag/daemon — End-to-end test: daemon with ingestion
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

import { LanceDbSchema, FakeEmbeddingProvider } from "@prag/core";
import { Daemon } from "../src/daemon.js";

function daemonWithIngestionSuite(): void {
  const ctx: {
    tmpDir: string;
    projectDir: string;
    schema: LanceDbSchema | null;
    daemon: Daemon | null;
  } = { tmpDir: "", projectDir: "", schema: null, daemon: null };

  after(async () => {
    await ctx.daemon?.stop();
    await ctx.schema?.close();
    if (ctx.tmpDir) rmSync(ctx.tmpDir, { recursive: true, force: true });
    // Allow the event loop to drain after closing the server + watchers
    await new Promise((r) => setImmediate(r));
  });

  void it("registers a project and indexes a file", async () => {
    ctx.tmpDir = mkdtempSync(join(tmpdir(), "prag-ing-e2e-"));
    ctx.projectDir = join(ctx.tmpDir, "project");
    mkdirSync(ctx.projectDir, { recursive: true });

    ctx.schema = new LanceDbSchema({
      dbPath: ctx.tmpDir,
      embeddingDim: 4,
      maxVectorUnitTokens: 512,
      modelMaxSeqLength: 512,
    });
    await ctx.schema.init();

    ctx.daemon = new Daemon({
      port: 0,
      token: "test-ingest",
      noExit: true,
      ingestion: { poolSize: 1, cooldownMs: 50 },
    });
    await ctx.daemon.start(ctx.schema, new FakeEmbeddingProvider(4));

    const port = ctx.daemon.boundPort!;

    // Register project
    const reg = await fetch(`http://127.0.0.1:${port}/projects`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-ingest",
      },
      body: JSON.stringify({ projectId: "e2e-test", rootUri: ctx.projectDir }),
    });
    assert.equal(reg.status, 200);

    // Write a file
    writeFileSync(join(ctx.projectDir, "hello.ts"), [
      "export function hello(): string {",
      '  return "world";',
      "}",
    ].join("\n"));

    // Wait for initial scan + cooldown
    await sleep(1500);

    // Sync to flush
    const syncRes = await fetch(`http://127.0.0.1:${port}/sync`, {
      method: "POST",
      headers: { Authorization: "Bearer test-ingest" },
    });
    assert.equal(syncRes.status, 200);

    // Search
    const searchRes = await fetch(`http://127.0.0.1:${port}/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-ingest",
      },
      body: JSON.stringify({ query: "hello world", limit: 5 }),
    });
    assert.equal(searchRes.status, 200);

    const body = await searchRes.json() as {
      hits: Array<{ uri: string }>;
      totalChunks: number;
    };
    assert.ok(Array.isArray(body.hits));
    const uris = body.hits.map((h) => h.uri);
    assert.ok(
      uris.some((u) => u.endsWith("hello.ts")),
      `hello.ts not in results: ${uris.join(", ")}`,
    );
  });
}
void describe("Daemon with ingestion", daemonWithIngestionSuite);
