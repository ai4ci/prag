import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { WorkerPool } from "./worker-pool.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = join(__dirname, "ingestion-worker.ts");

void describe("WorkerPool", () => {
  let pool: WorkerPool;

  after(() => {
    pool?.close().catch(() => {});
  });

  void it("spawns the requested number of workers", () => {
    pool = new WorkerPool(2, WORKER_SCRIPT);
    assert.equal(pool.totalWorkers, 2);
  });

  void it("processes a small TypeScript file", async () => {
    pool = new WorkerPool(1, WORKER_SCRIPT);
    const tmpDir = mkdtempSync(join(tmpdir(), "wp-test-"));
    const filePath = join(tmpDir, "test.ts");
    writeFileSync(filePath, "const x: number = 42;\nexport const y = x + 1;\n");

    const result = await pool.processFile("test-proj", filePath);

    assert.equal(result.projectId, "test-proj");
    assert.equal(result.filePath, filePath);
    assert.equal(result.error, undefined);
    assert.equal(result.chunks.length, 1);
    assert.equal(typeof result.chunks[0].chunkHash, "string");
    assert.equal(typeof result.chunks[0].text, "string");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  void it("processes a larger multi-chunk file", async () => {
    pool = new WorkerPool(1, WORKER_SCRIPT);
    const tmpDir = mkdtempSync(join(tmpdir(), "wp-test2-"));
    const filePath = join(tmpDir, "multi.ts");
    writeFileSync(
      filePath,
      [
        "function a() { return 1; }",
        "",
        "function b() { return 2; }",
        "",
        "function c() { return 3; }",
        "",
        "function d() { return 4; }",
        "",
        "function e() { return 5; }",
      ].join("\n"),
    );

    const result = await pool.processFile("test-proj", filePath);

    assert.equal(result.error, undefined);
    assert.ok(result.chunks.length >= 1);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  void it("returns an error for a non-existent file", async () => {
    pool = new WorkerPool(1, WORKER_SCRIPT);
    const result = await pool.processFile(
      "test-proj",
      "/tmp/nonexistent-file-12345.ts",
    );

    assert.ok(result.error, "expected error for missing file");
    assert.equal(result.chunks.length, 0);
  });

  void it("queues work when all workers are busy", async () => {
    pool = new WorkerPool(1, WORKER_SCRIPT);
    const tmpDir = mkdtempSync(join(tmpdir(), "wp-queue-"));
    const files = [];
    for (let i = 0; i < 3; i++) {
      const fp = join(tmpDir, `f${i}.ts`);
      writeFileSync(fp, `export const v${i}: number = ${i};\n`);
      files.push(fp);
    }

    // Submit all 3 files in parallel — only 1 worker, so 2 queue
    const results = await Promise.all(
      files.map((fp) => pool.processFile("test-proj", fp)),
    );

    assert.equal(results.length, 3);
    for (const r of results) {
      assert.equal(r.error, undefined);
      assert.ok(r.chunks.length >= 1);
    }

    rmSync(tmpDir, { recursive: true, force: true });
  });

  void it("handles concurrency with multiple workers", async () => {
    pool = new WorkerPool(3, WORKER_SCRIPT);
    const tmpDir = mkdtempSync(join(tmpdir(), "wp-concur-"));
    const files = [];
    for (let i = 0; i < 6; i++) {
      const fp = join(tmpDir, `con${i}.ts`);
      writeFileSync(fp, `export const w${i}: string = "hello";\n`);
      files.push(fp);
    }

    const results = await Promise.all(
      files.map((fp) => pool.processFile("test-proj", fp)),
    );

    assert.equal(results.length, 6);
    for (const r of results) {
      assert.equal(r.error, undefined);
    }

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
