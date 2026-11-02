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
    searchedPort: number | null;
  } = { tmpDir: "", projectDir: "", schema: null, daemon: null, searchedPort: null };

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
      ingestion: { poolSize: 1, cooldownMs: 50, maxFileBytes: 4096 },
    });
    await ctx.daemon.start(ctx.schema, new FakeEmbeddingProvider(4));

    const port = ctx.daemon.boundPort!;

    // A normal file, a file over maxFileBytes, and a file with a NUL byte in its
    // first 8KB — the two deliberate exclusions ADR-023 says must be reportable.
    writeFileSync(join(ctx.projectDir, "hello.ts"), [
      "export function hello(): string {",
      '  return "world";',
      "}",
    ].join("\n"));
    writeFileSync(join(ctx.projectDir, "huge.ts"), Buffer.alloc(9000, 0x61));
    writeFileSync(join(ctx.projectDir, "blob.bin"), Buffer.concat([
      Buffer.from("\x00\x01\x02binary", "latin1"),
      Buffer.alloc(64, 0x00),
    ]));

    // Register project (watcher starts its initial scan here)
    const reg = await fetch(`http://127.0.0.1:${port}/projects`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-ingest",
      },
      body: JSON.stringify({ projectId: "e2e-test", rootUri: ctx.projectDir }),
    });
    assert.equal(reg.status, 200);

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
    assert.ok(
      !uris.some((u) => u.endsWith("huge.ts") || u.endsWith("blob.bin")),
      `a file skipped at discovery was indexed: ${uris.join(", ")}`,
    );

    ctx.searchedPort = port;
  });

  void it("reports discovery skip counters per project", async () => {
    // The counters are only worth having if a *caller* can read them: the whole
    // point of ADR-023's skip reporting is that `prag status` can tell a user a
    // file was excluded on purpose. Counters alone were write-only.
    const port = ctx.searchedPort!;
    const res = await fetch(`http://127.0.0.1:${port}/projects`, {
      headers: { Authorization: "Bearer test-ingest" },
    });
    assert.equal(res.status, 200);

    const projects = (await res.json()) as Array<{
      projectId: string;
      status: string;
      skipped: Record<string, number>;
    }>;
    const project = projects.find((p) => p.projectId === "e2e-test");
    assert.ok(project, `e2e-test missing from ${JSON.stringify(projects)}`);
    assert.equal(
      project.skipped.tooLarge,
      1,
      `tooLarge counter missing: ${JSON.stringify(project.skipped)}`,
    );
    assert.equal(
      project.skipped.binary,
      1,
      `binary counter missing: ${JSON.stringify(project.skipped)}`,
    );
  });
}
void describe("Daemon with ingestion", daemonWithIngestionSuite);
