// @prag/daemon — two projects covering the same path are two pieces of work.
//
// `dirty` was keyed by uri alone, so the second project's event overwrote the
// first's: one ingestion ran and the owning projectId was whichever watcher
// reported last. Nothing orders those watchers, so ownership was decided by
// timing, and `file_mapping` being uri-keyed hid the collapse downstream
// (issue:ingestion-dirty-set-keyed-by-uri-alone.md).
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { WorkerPool, type ProcessResult } from "../src/worker-pool.js";
import { IngestionQueue } from "../src/ingestion-queue.js";

const WORKER_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "../src/ingestion-worker.ts");

function overlappingSuite(): void {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => { await cleanup?.(); cleanup = undefined; });

  void it("ingests a shared path once per project, not once in total", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prag-overlap-"));
    writeFileSync(join(dir, "shared.ts"), "export const shared = 1;\n");

    const pool = new WorkerPool(1, WORKER_SCRIPT);
    const ingested: ProcessResult[] = [];
    const queue = new IngestionQueue(pool, (r) => { ingested.push(r); }, { cooldownMs: 10 });
    cleanup = async () => {
      await queue.close();
      await pool.close();
      rmSync(dir, { recursive: true, force: true });
    };

    // Two projects over the same tree: what overlapping `prag watch` roots
    // produce, and what nested repositories produced before they were excluded.
    queue.registerProject("one", dir, 10);
    queue.registerProject("two", dir, 10);

    await queue.scanComplete();
    await queue.flushAll();

    // Distinct owners: the claim is that BOTH projects ingest the path, not how
    // many times each did. A reconcile pass can legitimately re-dispatch a file
    // (writes are idempotent), so counting occurrences makes the test flaky
    // without making it stricter about the thing under test.
    const owners = () => [...new Set(
      ingested.filter((r) => r.filePath.endsWith("shared.ts")).map((r) => r.projectId),
    )].sort();

    // Polled: chokidar delivery and a worker round trip are both unbounded, and
    // under `npm test` three packages contend for one event loop. Asserting
    // straight after flushAll passed on an idle machine and failed in the full
    // suite.
    const deadline = Date.now() + 10_000;
    while (owners().length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }

    assert.deepEqual(owners(), ["one", "two"],
      `each project must ingest the path it watches; got ${JSON.stringify(owners())}`);
  });

  void it("reports the shared path as pending for each project separately", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prag-overlap-pending-"));
    writeFileSync(join(dir, "shared.ts"), "export const shared = 2;\n");

    const pool = new WorkerPool(1, WORKER_SCRIPT);
    // A cooldown long enough that the events stay queued while we look at them.
    const queue = new IngestionQueue(pool, () => {}, { cooldownMs: 60_000 });
    cleanup = async () => {
      await queue.close();
      await pool.close();
      rmSync(dir, { recursive: true, force: true });
    };

    queue.registerProject("one", dir, 60_000);
    queue.registerProject("two", dir, 60_000);
    await queue.scanComplete();

    // Each project owns its own queue entry; a uri-only key left exactly one.
    assert.deepEqual(queue.pendingUris("one").filter((u) => u.endsWith("shared.ts")).length, 1);
    assert.deepEqual(queue.pendingUris("two").filter((u) => u.endsWith("shared.ts")).length, 1);
  });
}

void describe("overlapping projects", overlappingSuite);
