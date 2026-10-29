import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { WorkerPool, type ProcessResult } from "./worker-pool.js";
import { IngestionQueue } from "./ingestion-queue.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = join(__dirname, "ingestion-worker.ts");

// ── Fixture: each test gets a self-contained pool+queue+tmpdir ───────

interface TestCtx {
  tmpDir: string;
  ingested: ProcessResult[];
  pool: WorkerPool;
  queue: IngestionQueue;
  cleanup: () => Promise<void>;
}

let ctx: TestCtx | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
  // Allow chokidar's native fs.watch handle to release. Without this,
  // the event loop can retain pending work that prevents the test
  // runner from draining.
  await new Promise((r) => setImmediate(r));
});

function setup(cooldownMs = 100): TestCtx {
  const tmpDir = mkdtempSync(join(tmpdir(), "ingq-"));
  const ingested: ProcessResult[] = [];
  const pool = new WorkerPool(1, WORKER_SCRIPT);
  const queue = new IngestionQueue(pool, (r) => ingested.push(r), {
    cooldownMs,
  });

  const cleanup = async () => {
    await queue.close();
    await pool.close();
    rmSync(tmpDir, { recursive: true, force: true });
  };

  ctx = { tmpDir, ingested, pool, queue, cleanup };
  return ctx;
}

// ── Tests ────────────────────────────────────────────────────────────

void describe("IngestionQueue", () => {
  void it("discovers existing files on register", async () => {
    const { tmpDir, ingested, queue } = setup();

    writeFileSync(join(tmpDir, "existing.ts"), "export const a = 1;\n");
    queue.registerProject("test", tmpDir);

    // Poll for up to 2s — chokidar's initial scan is async
    for (let i = 0; i < 20; i++) {
      if (ingested.some((r) => r.filePath.endsWith("existing.ts"))) break;
      await sleep(100);
    }

    assert.ok(
      ingested.some((r) => r.filePath.endsWith("existing.ts")),
      "should discover existing.ts",
    );
  });

  void it("processes newly added files", async () => {
    const { tmpDir, ingested, queue } = setup(50);

    queue.registerProject("test2", tmpDir);
    await sleep(200);

    writeFileSync(join(tmpDir, "new.ts"), "export const b = 2;\n");
    await sleep(500);

    const found = ingested.find((r) => r.filePath.endsWith("new.ts"));
    assert.ok(found, "should ingest new.ts");
    assert.ok(
      found?.chunks.some((c) => c.text.includes("b = 2")),
      "content should match",
    );
  });

  void it("debounces rapid changes to the same file", async () => {
    const { tmpDir, ingested, queue } = setup(200);

    queue.registerProject("test3", tmpDir);
    await sleep(300);

    const fp = join(tmpDir, "rapid.ts");
    writeFileSync(fp, "export const c = 1;\n");
    await sleep(50);
    writeFileSync(fp, "export const c = 2;\n");
    await sleep(50);
    writeFileSync(fp, "export const c = 3;\n");
    await sleep(500);

    const hits = ingested.filter((r) =>
      r.filePath.endsWith("rapid.ts") && r.chunks.length > 0
    );
    assert.equal(hits.length, 1, "one shot after debounce");
    assert.ok(
      hits[0]?.chunks.some((c) => c.text.includes("c = 3")),
      "final content",
    );
  });

  void it("skips binary files", async () => {
    const { tmpDir, ingested, queue } = setup(50);

    queue.registerProject("test4", tmpDir);
    await sleep(200);

    writeFileSync(join(tmpDir, "binary.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
    await sleep(400);

    assert.equal(
      ingested.some((r) => r.filePath.endsWith("binary.bin")),
      false,
      "binary files skipped",
    );
    assert.equal(queue.getSkipCounters("test4").binary, 1);
  });

  void it("skips hidden files", async () => {
    const { tmpDir, ingested, queue } = setup(50);

    queue.registerProject("test5", tmpDir);
    await sleep(200);

    writeFileSync(join(tmpDir, ".secret.ts"), "export const hidden = 1;\n");
    await sleep(400);

    assert.equal(
      ingested.some((r) => r.filePath.includes(".secret.ts")),
      false,
      "hidden files skipped",
    );
  });

  void it("handles file deletion", async () => {
    const { tmpDir, ingested, queue } = setup(50);

    queue.registerProject("test6", tmpDir);
    await sleep(200);

    const fp = join(tmpDir, "todelete.ts");
    writeFileSync(fp, "export const d = 1;\n");
    await sleep(200);

    rmSync(fp);
    await sleep(400);

    assert.ok(
      ingested.some((r) => r.filePath.endsWith("todelete.ts")),
      "deletion notified",
    );
  });

  void it("flushAll bypasses cooldown", async () => {
    const { tmpDir, ingested, queue } = setup(5000);

    queue.registerProject("test7", tmpDir);
    await sleep(200);

    writeFileSync(join(tmpDir, "flush.ts"), "export const e = 5;\n");
    await sleep(100);
    await queue.flushAll();
    await sleep(300);

    assert.ok(
      ingested.some((r) => r.filePath.endsWith("flush.ts")),
      "flushAll processes immediately",
    );
  });

  void it("reports skip counters per project", async () => {
    const { tmpDir, queue } = setup(50);

    queue.registerProject("skip-test", tmpDir);
    await sleep(200);

    writeFileSync(join(tmpDir, "foo.bin"), Buffer.from([0x00, 0x01]));
    await sleep(400);

    const counters = queue.getSkipCounters("skip-test");
    assert.equal(counters.binary, 1);
  });
});
