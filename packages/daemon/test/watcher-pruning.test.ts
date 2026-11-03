// @prag/daemon — the watcher must prune ignored subtrees at the walk, not
// after the event.
//
// chokidar was given no `ignored` option, so it enumerated and placed an
// inotify watch on every directory in a project -- `node_modules` included --
// and `_shouldIgnore` discarded the events afterwards. Correct, and very
// expensive. Measured on a tree of 70,000 `node_modules` directories:
//
//   | | ready | RSS | kernel |
//   |---|---|---|---|
//   | no `ignored` | 3.3s | 551MB | **ENOSPC** |
//   | with `ignored` | 6ms | 71MB | clean |
//
// ENOSPC is `fs.inotify.max_user_watches` running out, after which an
// arbitrary subset of the tree has no watch at all. A `git clone` of a large
// dependency tree into an already-watched directory is enough to trigger it.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { WorkerPool } from "../src/worker-pool.js";
import { IngestionQueue } from "../src/ingestion-queue.js";

const WORKER_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "../src/ingestion-worker.ts");

function watcherPruningSuite(): void {
  let base = "";
  let root = "";

  before(() => {
    base = mkdtempSync(join(tmpdir(), "prag-prune-"));
    root = join(base, "repo");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "real.ts"), "export const real = 1;\n");
    // Big enough that walking it is unmistakable in the event count, small
    // enough to build in a test.
    for (let i = 0; i < 300; i++) {
      const dir = join(root, "node_modules", `pkg${i}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "index.js"), `module.exports = ${i};\n`);
    }
  });

  after(() => { rmSync(base, { recursive: true, force: true }); });

  void it("never enumerates an ignored subtree", async () => {
    // The observable proxy for "chokidar did not walk it": the admitted-file
    // callback. Before the fix every node_modules file produced an `add` that
    // was then thrown away; the pruning makes them never arrive.
    const seen: string[] = [];
    const pool = new WorkerPool(1, WORKER_SCRIPT);
    const queue = new IngestionQueue(pool, (r) => { seen.push(r.filePath); }, {
      poolSize: 1, cooldownMs: 5,
    });
    try {
      queue.registerProject("repo", root);
      await queue.scanComplete("repo");
      await queue.flushAll();
      await queue.drain();

      assert.ok(seen.some((p) => p.endsWith("src/real.ts")),
        `the real source file was not indexed: ${JSON.stringify(seen)}`);
      const leaked = seen.filter((p) => p.includes("node_modules"));
      assert.deepEqual(leaked, [], `${leaked.length} node_modules files reached ingestion`);

      // The assertion that distinguishes pruning from post-hoc filtering.
      // `seen` is identical either way -- `_shouldIgnore` already dropped
      // those events -- so only the watch count shows whether chokidar walked
      // the tree. 300 package directories plus `node_modules` itself is 301
      // watches that must not exist; what is left is the root and `src`.
      const watched = queue.watchedDirCount("repo");
      assert.ok(watched <= 4,
        `chokidar is holding ${watched} directory watches; the ignored subtree ` +
        "was enumerated rather than pruned");

      // No watcher error: 300 directories is far inside any sane limit, so a
      // failure here would mean something other than the watch budget.
      assert.deepEqual(queue.stats().watcherErrors, {});
    } finally {
      await queue.close();
      await pool.close();
    }
  });

  void it("watches a project that lives under a hidden directory", async () => {
    // Same root-scoping bug as `coretest:ignore-scope.test.ts`, on the
    // watcher side: every event was discarded because the *root* contained a
    // hidden segment, so the project indexed nothing and said nothing.
    const hiddenRoot = join(base, ".config", "notes");
    mkdirSync(join(hiddenRoot, "src"), { recursive: true });
    writeFileSync(join(hiddenRoot, "src", "note.md"), "# Note\n\nSome prose here.\n");

    const seen: string[] = [];
    const pool = new WorkerPool(1, WORKER_SCRIPT);
    const queue = new IngestionQueue(pool, (r) => { seen.push(r.filePath); }, {
      poolSize: 1, cooldownMs: 5,
    });
    try {
      queue.registerProject("notes", hiddenRoot);
      await queue.scanComplete("notes");
      await queue.flushAll();
      await queue.drain();
      assert.ok(seen.some((p) => p.endsWith("note.md")),
        `nothing was indexed under a hidden root: ${JSON.stringify(seen)}`);
    } finally {
      await queue.close();
      await pool.close();
    }
  });
}
void describe("watcher subtree pruning", watcherPruningSuite);
