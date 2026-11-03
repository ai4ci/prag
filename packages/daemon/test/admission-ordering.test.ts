// @prag/daemon — ADR-009 §1: a denied path is refused at admission.
//
// The queue used to admit every event and only consult grants when the entry
// drained, so a file the user had explicitly denied still took a slot in the
// dirty set and held a debounce timer until it was thrown away. The content
// probe (size/empty/binary) deliberately stays at flush: it is file I/O, and
// debouncing exists to do it once per burst rather than once per event.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { WorkerPool, type ProcessResult } from "../src/worker-pool.js";
import { IngestionQueue } from "../src/ingestion-queue.js";
import type { GrantRow } from "@prag/core";

const WORKER_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "../src/ingestion-worker.ts");

async function waitFor(what: string, pred: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function admissionSuite(): void {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => { await cleanup?.(); cleanup = undefined; });

  void it("never queues a denied path, and counts it as denied", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prag-admission-"));
    writeFileSync(join(dir, "keep.ts"), "export const keep = 1;\n");
    writeFileSync(join(dir, "secret.env.ts"), "export const SECRET = 'x';\n");

    const grants: GrantRow[] = [
      { pattern: `file://${dir}/**`, action: "allow", reason: "watch_root", createdAt: new Date() },
      { pattern: `file://${dir}/secret.env.ts`, action: "deny", reason: "user_deny", createdAt: new Date() },
    ];

    const pool = new WorkerPool(1, WORKER_SCRIPT);
    const ingested: ProcessResult[] = [];
    // A long cooldown: anything admitted stays visible in pendingUris instead
    // of draining before the assertion can see it.
    const queue = new IngestionQueue(pool, (r) => { ingested.push(r); }, {
      cooldownMs: 60_000,
      grants: async () => grants,
    });
    cleanup = async () => {
      await queue.close();
      await pool.close();
      rmSync(dir, { recursive: true, force: true });
    };

    queue.registerProject("p", dir, 60_000);
    await queue.scanComplete();
    await waitFor("the allowed file to be queued",
      () => queue.pendingUris("p").some((u) => u.endsWith("keep.ts")));

    const pending = queue.pendingUris("p");
    assert.ok(
      !pending.some((u) => u.endsWith("secret.env.ts")),
      `a denied path took a queue slot: ${JSON.stringify(pending)}`,
    );
    // Counted at admission, so `prag status` can explain the absence.
    assert.equal(queue.getSkipCounters("p").denied, 1);
  });

  void it("still admits when the grant cache is cold, deferring to the flush check", async () => {
    // The gate reads an in-memory cache and must never treat "don't know yet"
    // as "allowed forever" -- the flush-time check stays authoritative.
    const dir = mkdtempSync(join(tmpdir(), "prag-admission-cold-"));
    writeFileSync(join(dir, "secret.env.ts"), "export const SECRET = 'x';\n");

    const grants: GrantRow[] = [
      { pattern: `file://${dir}/**`, action: "allow", reason: "watch_root", createdAt: new Date() },
      { pattern: `file://${dir}/secret.env.ts`, action: "deny", reason: "user_deny", createdAt: new Date() },
    ];

    const pool = new WorkerPool(1, WORKER_SCRIPT);
    const ingested: ProcessResult[] = [];
    const queue = new IngestionQueue(pool, (r) => { ingested.push(r); }, {
      cooldownMs: 10,
      // Never resolves in time to warm the cache before the first events.
      grants: async () => { await new Promise((r) => setTimeout(r, 150)); return grants; },
    });
    cleanup = async () => {
      await queue.close();
      await pool.close();
      rmSync(dir, { recursive: true, force: true });
    };

    queue.registerProject("p", dir, 10);
    await queue.scanComplete();
    await queue.flushAll();

    // Whatever the gate did, the denied file must not have been ingested.
    assert.ok(
      !ingested.some((r) => r.filePath.endsWith("secret.env.ts")),
      "a denied file was ingested when the grant cache was cold",
    );
  });
}

void describe("ingestion admission ordering", admissionSuite);
