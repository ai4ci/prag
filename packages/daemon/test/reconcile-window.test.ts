// @prag/daemon — the reconcile walk's scan window.
//
// `flushAll` reconciles from disk before dispatching, because event delivery
// cannot be trusted ("trust the disk, not event delivery"). That promise
// rests on one stamp per project: everything with an mtime older than it has
// been seen. Two ways the stamp lied, both found while chasing a ~1-in-15
// suite flake whose symptom was simply that nothing got indexed.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { WorkerPool } from "../src/worker-pool.js";
import { IngestionQueue } from "../src/ingestion-queue.js";

const WORKER_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "../src/ingestion-worker.ts");

function reconcileWindowSuite(): void {
  let base = "";
  before(() => { base = mkdtempSync(join(tmpdir(), "prag-reconcile-")); });
  after(() => {
    // Restore any mode we broke, or the cleanup cannot recurse.
    try { chmodSync(join(base, "locked", "sub"), 0o755); } catch { /* not created */ }
    rmSync(base, { recursive: true, force: true });
  });

  void it("re-examines files touched close to the previous walk", async () => {
    // The stamp was taken before the walk and compared with a strict `>`, so
    // a file whose mtime landed on or just under it was invisible to that
    // reconcile -- and, once the stamp advanced, to every later one too. A
    // permanent loss from a millisecond of bad luck, and a whole second of
    // them on a filesystem with coarse mtime granularity.
    //
    // Tested without touching the file, deliberately. Anything that changes
    // it -- a write, even a `utimes` -- makes the watcher report it, and the
    // event then satisfies the assertion whether or not the reconcile would
    // have. Two flushes with nothing happening in between isolate the walk:
    // the file's mtime is just under the first walk's stamp, so a strict
    // comparison never offers it again and an overlapping one does.
    const root = join(base, "racy");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "first.ts"), "export const first = 1;\n");

    const seen: string[] = [];
    const pool = new WorkerPool(1, WORKER_SCRIPT);
    const queue = new IngestionQueue(pool, (r) => { seen.push(r.filePath); }, { cooldownMs: 5 });
    try {
      queue.registerProject("racy", root);
      await queue.scanComplete("racy");
      await queue.flushAll();
      await queue.drain();
      assert.ok(seen.some((p) => p.endsWith("first.ts")), "the initial scan indexed nothing");

      seen.length = 0;
      await queue.flushAll();
      await queue.drain();
      assert.ok(seen.some((p) => p.endsWith("first.ts")),
        "a file written moments before the last walk is already past the scan " +
        `window, so a write landing during a walk would be lost: ${JSON.stringify(seen)}`);
    } finally {
      await queue.close();
      await pool.close();
    }
  });

  void it("keeps the window open when part of the tree could not be read", async () => {
    // readdir failures were swallowed with a bare `continue` on the
    // assumption that the only cause was permissions, which the watcher
    // reports as `denied`. Under load the real causes are EMFILE and ENOMEM,
    // which are transient and report nothing -- and the stamp advanced
    // anyway, so a momentary descriptor shortage lost that subtree's files
    // for good. A walk that could not read the tree has not earned the stamp.
    const root = join(base, "locked");
    const sub = join(root, "sub");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(root, "visible.ts"), "export const visible = 1;\n");
    writeFileSync(join(sub, "hidden-by-mode.ts"), "export const h = 2;\n");

    const seen: string[] = [];
    const pool = new WorkerPool(1, WORKER_SCRIPT);
    const queue = new IngestionQueue(pool, (r) => { seen.push(r.filePath); }, { cooldownMs: 5 });
    try {
      // Unreadable directory: readdir raises EACCES, standing in for the
      // EMFILE that actually bites under load. Same code path.
      chmodSync(sub, 0o000);
      queue.registerProject("locked", root);
      await queue.scanComplete("locked");
      await queue.flushAll();
      await queue.drain();
      assert.ok(seen.some((p) => p.endsWith("visible.ts")),
        "an unreadable subtree stopped the rest of the project being indexed");

      // Readable again, and nothing on disk has changed.
      chmodSync(sub, 0o755);
      seen.length = 0;
      await queue.flushAll();
      await queue.drain();

      // `visible.ts` is the load-bearing assertion, and it is deliberately
      // not `hidden-by-mode.ts`. Restoring the mode makes the watcher notice
      // the subtree, so the hidden file can arrive by event even when the
      // reconcile has given up on it -- which made an earlier version of
      // this test pass against the bug. `visible.ts` has not changed, so no
      // event will ever mention it again: the only thing that can re-offer
      // it is a scan window that stayed open.
      assert.ok(seen.some((p) => p.endsWith("visible.ts")),
        "the failed walk advanced the scan window, so unchanged files are " +
        `now permanently past it: ${JSON.stringify(seen)}`);
      assert.ok(seen.some((p) => p.endsWith("hidden-by-mode.ts")),
        `the previously unreadable file was never picked up: ${JSON.stringify(seen)}`);
    } finally {
      try { chmodSync(sub, 0o755); } catch { /* already restored */ }
      await queue.close();
      await pool.close();
    }
  });
}
void describe("reconcile scan window", reconcileWindowSuite);
