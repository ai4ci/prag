// @prag/daemon — ADR-023 runtime growth bound.
//
// `watchConfirmThreshold` asks "is this too much to take on?" once, at `prag
// watch`. Nothing asked it again afterwards, so moving or cloning a large
// directory into an already-watched project committed the machine to parsing
// and embedding all of it with no prompt and no way to see it coming.
//
// The breaker holds the project instead. Held, not refused: the files stay on
// disk, nothing leaves the index, and `prag resume` re-walks and indexes
// them -- so a user who meant it pays one command, and one who did not has
// time to `prag deny` first. Refusing would leave the project silently
// under-indexed, which ADR-023 forbids.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { WorkerPool } from "../src/worker-pool.js";
import { IngestionQueue, type GrowthBreach, type GrowthLimits } from "../src/ingestion-queue.js";

const WORKER_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "../src/ingestion-worker.ts");

/** A project with `count` source files under `subdir`. */
function seed(root: string, subdir: string, count: number, body = "export const x = 1;\n"): void {
  mkdirSync(join(root, subdir), { recursive: true });
  for (let i = 0; i < count; i++) {
    writeFileSync(join(root, subdir, `f${i}.ts`), body);
  }
}

interface Harness {
  queue: IngestionQueue;
  pool: WorkerPool;
  breaches: GrowthBreach[];
  /**
   * Register the project and get past the confirmed initial scan.
   *
   * The breaker arms when the *first flush* completes, not when chokidar is
   * ready: `ready` means the walk finished, and the walk's files have not yet
   * been through admission. Every test that wants an armed breaker has to
   * come through here, which is also the clearest statement of the rule.
   */
  arm: (projectId: string, root: string) => Promise<void>;
  settle: () => Promise<void>;
  close: () => Promise<void>;
}

function harness(growth: GrowthLimits): Harness {
  const breaches: GrowthBreach[] = [];
  const pool = new WorkerPool(1, WORKER_SCRIPT);
  const queue = new IngestionQueue(pool, () => {}, {
    poolSize: 1,
    cooldownMs: 5,
    growth,
    onGrowthBreach: (b) => breaches.push(b),
  });
  const settle = async (): Promise<void> => {
    await queue.flushAll();
    await queue.drain();
  };
  return {
    queue, pool, breaches, settle,
    arm: async (projectId, root) => {
      queue.registerProject(projectId, root);
      await queue.scanComplete(projectId);
      await settle();
    },
    close: async () => { await queue.close(); await pool.close(); },
  };
}

function growthBreakerSuite(): void {
  let base = "";
  before(() => { base = mkdtempSync(join(tmpdir(), "prag-growth-")); });
  after(() => { rmSync(base, { recursive: true, force: true }); });

  let n = 0;
  const freshRoot = (): string => {
    const root = join(base, `p${n++}`);
    mkdirSync(root, { recursive: true });
    return root;
  };

  void it("does not fire on the initial scan, which the user already confirmed", async () => {
    // `prag watch` runs the ADR-023 dry run and asks before registering. The
    // breaker firing on that same content would be the prompt asked twice,
    // and the second time with no way to say yes except `prag resume`.
    const root = freshRoot();
    seed(root, "src", 40);
    const h = harness({ maxFiles: 5, windowMs: 60_000 });
    try {
      h.queue.registerProject("proj", root);
      await h.queue.scanComplete("proj");
      await h.queue.flushAll();
      await h.queue.drain();
      assert.deepEqual(h.breaches, [], "the breaker fired on the confirmed initial scan");
    } finally { await h.close(); }
  });

  void it("fires when files arrive after registration", async () => {
    const root = freshRoot();
    seed(root, "src", 2);
    const h = harness({ maxFiles: 5, windowMs: 60_000 });
    try {
      await h.arm("proj", root);
      // `assert.equal` on the length, not `deepEqual` on the array: the
      // latter carries an `asserts actual is T` signature that narrows
      // `breaches` to `never[]` for the rest of the function.
      assert.equal(h.breaches.length, 0);

      // The accident: a directory lands in an already-watched project.
      seed(root, "dumped", 30);
      await h.settle();

      assert.equal(h.breaches.length, 1,
        `expected exactly one breach, got ${h.breaches.length}`);
      const b = h.breaches[0];
      assert.equal(b.projectId, "proj");
      assert.equal(b.limit, "files");
      assert.ok(b.files > 5, `files=${b.files}`);
      assert.equal(b.topDirectory, "dumped",
        "the breach did not name the directory that caused it");
    } finally { await h.close(); }
  });

  void it("reports the breach through stats, so a hold is not a mystery", async () => {
    const root = freshRoot();
    const h = harness({ maxFiles: 3, windowMs: 60_000 });
    try {
      await h.arm("proj", root);
      seed(root, "dumped", 20);
      await h.settle();

      const held = h.queue.stats().growthBreaches;
      assert.ok(held.proj, `no breach in stats: ${JSON.stringify(held)}`);
      assert.equal(held.proj.limit, "files");
    } finally { await h.close(); }
  });

  void it("fires once per burst, not once per file", async () => {
    // The rest of the burst is already in the dirty set when the breaker
    // trips, and the daemon's pause is asynchronous, so without in-memory
    // suppression every remaining file would raise its own breach and the
    // log would be thousands of lines.
    const root = freshRoot();
    const h = harness({ maxFiles: 2, windowMs: 60_000 });
    try {
      await h.arm("proj", root);
      seed(root, "dumped", 60);
      await h.settle();
      assert.equal(h.breaches.length, 1,
        `the breaker fired ${h.breaches.length} times for one burst`);
    } finally { await h.close(); }
  });

  void it("trips on bytes even when the file count is small", async () => {
    // The other shape of the same accident: a few very large files. Counting
    // files alone would wave them through.
    const root = freshRoot();
    const big = "x".repeat(200_000) + "\n";
    const h = harness({ maxFiles: 0, maxBytes: 300_000, windowMs: 60_000 });
    try {
      await h.arm("proj", root);
      seed(root, "bulk", 4, big);
      await h.settle();
      assert.equal(h.breaches.length, 1, JSON.stringify(h.breaches));
      assert.equal(h.breaches[0].limit, "bytes");
    } finally { await h.close(); }
  });

  void it("does not fire again on the rescan that resume triggers", async () => {
    // Otherwise `prag resume` is an infinite loop: resume, re-walk, trip,
    // hold, resume. The rescan is the user's explicit yes.
    const root = freshRoot();
    const h = harness({ maxFiles: 3, windowMs: 60_000 });
    try {
      await h.arm("proj", root);
      seed(root, "dumped", 20);
      await h.settle();
      assert.equal(h.breaches.length, 1);

      h.queue.rescan("proj");           // what /resume does
      await h.settle();

      assert.equal(h.breaches.length, 1,
        "the breaker fired again on the rescan, so resume could never complete");
      assert.deepEqual(h.queue.stats().growthBreaches, {},
        "the hold was not cleared on resume");
    } finally { await h.close(); }
  });

  void it("is disabled when both limits are zero", async () => {
    const root = freshRoot();
    const h = harness({ maxFiles: 0, maxBytes: 0, windowMs: 60_000 });
    try {
      await h.arm("proj", root);
      seed(root, "dumped", 40);
      await h.settle();
      assert.deepEqual(h.breaches, []);
    } finally { await h.close(); }
  });

  void it("lets steady work through: the window resets", async () => {
    // A long-lived busy project must never accumulate its way into a hold.
    // A 1ms window makes every file its own window.
    const root = freshRoot();
    const h = harness({ maxFiles: 3, windowMs: 1 });
    try {
      await h.arm("proj", root);
      for (let i = 0; i < 6; i++) {
        writeFileSync(join(root, `drip${i}.ts`), `export const d${i} = ${i};\n`);
        await h.settle();
        await new Promise((r) => setTimeout(r, 3));
      }
      assert.deepEqual(h.breaches, [], "steady work tripped the breaker");
    } finally { await h.close(); }
  });
}
void describe("ingestion growth breaker", growthBreakerSuite);

// ── Through the daemon ────────────────────────────────────────────────

import { mkdtempSync as mkTmp } from "node:fs";
import { LanceDbSchema, FakeEmbeddingProvider } from "@prag/core";
import { Daemon } from "../src/daemon.js";

function growthBreakerDaemonSuite(): void {
  const ctx: { tmp: string; schema: LanceDbSchema | null; daemon: Daemon | null } =
    { tmp: "", schema: null, daemon: null };

  after(async () => {
    await ctx.daemon?.stop();
    await ctx.schema?.close();
    if (ctx.tmp) rmSync(ctx.tmp, { recursive: true, force: true });
  });

  void it("holds the project in the database, and resume indexes the content", async () => {
    // The queue-level tests prove the breaker fires. This proves the daemon
    // acts on it: `projects.status` becomes `paused`, which is what stops
    // admission across a restart and what `prag projects` shows.
    ctx.tmp = mkTmp(join(tmpdir(), "prag-growth-daemon-"));
    const corpus = join(ctx.tmp, "corpus");
    mkdirSync(join(corpus, "src"), { recursive: true });
    writeFileSync(join(corpus, "src", "app.ts"), "export const app = 'vector pool';\n");

    ctx.schema = new LanceDbSchema({
      dbPath: join(ctx.tmp, "lancedb"),
      embeddingDim: 4, maxVectorUnitTokens: 512, modelMaxSeqLength: 512,
    });
    await ctx.schema.init();
    ctx.daemon = new Daemon({
      port: 0, token: "t", noExit: true,
      ingestion: {
        poolSize: 1, cooldownMs: 5,
        growth: { maxFiles: 5, windowMs: 60_000 },
      },
    });
    await ctx.daemon.start(ctx.schema, new FakeEmbeddingProvider(4));
    const port = ctx.daemon.boundPort!;
    const headers = { "Content-Type": "application/json", Authorization: "Bearer t" };
    const post = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST", headers, body: JSON.stringify(body),
      });

    const watch = await post("/projects/watch",
      { uri: `file://${corpus}`, projectId: "local", confirm: true });
    assert.equal(watch.status, 200, await watch.text());
    await post("/sync", { projectId: "local" });

    const statusOf = async (): Promise<string> => {
      const rows = (await ctx.schema!.table("projects").query().limit(10).toArray()) as
        Array<{ projectId: string; status: string }>;
      return rows.find((r) => r.projectId === "local")?.status ?? "(missing)";
    };
    assert.equal(await statusOf(), "active", "the confirmed initial scan held the project");

    // The accident.
    seed(corpus, "dumped", 40);
    await post("/sync", { projectId: "local" });

    assert.equal(await statusOf(), "paused",
      "a 40-file drop into a watched project did not hold it");

    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json() as
      { ingestion?: { growthBreaches?: Record<string, { limit: string; topDirectory?: string }> } };
    const breach = health.ingestion?.growthBreaches?.local;
    assert.ok(breach, `the hold is not reported by /health: ${JSON.stringify(health.ingestion)}`);
    assert.equal(breach.limit, "files");
    assert.equal(breach.topDirectory, "dumped");

    // Resume is the user saying yes. It must index the content, not hold again.
    const resume = await post("/resume", { projectId: "local" });
    assert.equal(resume.status, 200, await resume.text());
    await post("/sync", { projectId: "local" });

    assert.equal(await statusOf(), "active", "resume did not stick");
    const indexed = (await ctx.schema!.table("file_mapping").query().limit(200).toArray()) as
      Array<{ uri: string }>;
    const dumped = indexed.filter((r) => r.uri.includes("/dumped/"));
    assert.equal(dumped.length, 40,
      `resume indexed ${dumped.length} of the 40 held files`);
  });
}
void describe("ingestion growth breaker (daemon)", growthBreakerDaemonSuite);
