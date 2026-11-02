// @prag/daemon — ADR-015 re-embed rebuild
//
// The contract under test is "drop and requeue", not "swap the vectors".
// A rebuild that merely re-embedded chunks_pool in place looked identical from
// the outside while being unable to absorb a dimension change, so these tests
// assert on what survives the drop and on the dimension actually pinned.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import {
  LanceDbSchema,
  FakeEmbeddingProvider,
  DaemonFailure,
  readEmbeddingSidecar,
  writeEmbeddingSidecar,
  upsertProjects,
  upsertChunksPool,
  type EmbeddingProvider,
} from "@prag/core";
import { Daemon, type RebuildResult } from "../src/daemon.js";

const TOKEN = "test-reembed";
const HEADERS = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${TOKEN}`,
};

interface Rig {
  daemon: Daemon;
  port: number;
  dbPath: string;
  projectDir: string;
  rebuilds: Array<string | undefined>;
  schema: () => LanceDbSchema;
  cleanup: () => Promise<void>;
}

/**
 * A daemon wired to the same shape main.ts injects: a rebuild hook that drops
 * the content tables, reopens at the new dimension and pins the sidecar.
 * `degraded` starts it with no database, which is the mismatch state /reembed
 * exists to escape.
 */
async function rig(opts: { degraded?: boolean; startDim?: number } = {}): Promise<Rig> {
  const root = mkdtempSync(join(tmpdir(), "prag-reembed-"));
  const dbPath = join(root, "lancedb");
  const startDim = opts.startDim ?? 4;

  const projectDir = join(root, "proj");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "a.ts"), "export const alpha = 1;\n");

  let live: LanceDbSchema = new LanceDbSchema({
    dbPath,
    embeddingDim: startDim,
    maxVectorUnitTokens: 64,
    modelMaxSeqLength: 512,
  });
  await live.init();
  writeEmbeddingSidecar(dbPath, {
    model: `fake:${startDim}`,
    dim: startDim,
    maxSeqLength: 512,
    pinnedAt: new Date().toISOString(),
  });

  // A registered project the rebuild must preserve and requeue.
  await upsertProjects(live.table("projects"), [{
    projectId: "p1",
    rootUri: pathToFileURL(projectDir).href,
    name: "proj",
    isGit: false,
    defaultCooldownSeconds: 1,
    status: "active",
    registeredAt: new Date(),
    lastSyncedAt: new Date(),
  }]);
  // Content that must NOT survive the drop.
  await upsertChunksPool(live.table("chunks_pool"), [{
    chunkHash: "h1",
    text: "some indexed text",
    scopeContext: null,
  }]);

  const rebuilds: Array<string | undefined> = [];
  const rebuild = async (modelId?: string): Promise<RebuildResult> => {
    rebuilds.push(modelId);
    const dim = modelId?.startsWith("fake:") ? Number(modelId.slice(5)) : startDim;
    const provider: EmbeddingProvider = new FakeEmbeddingProvider(dim);
    await live.dropContentTables();
    await live.close();
    const next = new LanceDbSchema({
      dbPath,
      embeddingDim: dim,
      maxVectorUnitTokens: 64,
      modelMaxSeqLength: provider.maxSeqLength,
    });
    await next.init();
    writeEmbeddingSidecar(dbPath, {
      model: provider.model,
      dim: provider.dim,
      maxSeqLength: provider.maxSeqLength,
      pinnedAt: new Date().toISOString(),
    });
    live = next;
    return { schema: next, provider, maxVectorUnitTokens: 64 };
  };

  const daemon = new Daemon({ port: 0, token: TOKEN, noExit: true });
  if (opts.degraded) {
    const mismatch = new DaemonFailure(
      "EMBEDDING_MODEL_MISMATCH", "pinned model differs", "Run `prag reembed`.");
    await daemon.start(null, null, { mismatch, rebuild });
  } else {
    await daemon.start(live, new FakeEmbeddingProvider(startDim), {
      maxVectorUnitTokens: 64,
      rebuild,
    });
  }

  return {
    daemon,
    port: daemon.boundPort!,
    dbPath,
    projectDir,
    rebuilds,
    schema: () => live,
    cleanup: async () => {
      await daemon.stop();
      try { await live.close(); } catch { /* already closed by a rebuild */ }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function post(port: number, body: unknown) {
  return fetch(`http://127.0.0.1:${port}/reembed`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
}

function reembedSuite(): void {
  void it("drops content, keeps the registry, and requeues every project", async () => {
    const r = await rig();
    try {
      const res = await post(r.port, {});
      const body = (await res.json()) as { requeued: number; model: string; dim: number };
      assert.equal(res.status, 200, JSON.stringify(body));

      // ADR-015 §3: returns the project count, not a chunk count. The CLI
      // prints this as "projects", so a chunk count here was a visible lie.
      assert.equal(body.requeued, 1);

      // Content-derived rows are gone...
      const chunks = await r.schema().table("chunks_pool").query().limit(10).toArray();
      assert.equal(chunks.length, 0, "chunks_pool survived the drop");

      // ...while the registry that says what to rescan survived.
      const projects = await r.schema().table("projects").query().limit(10).toArray();
      assert.equal(projects.length, 1);
      assert.equal((projects[0] as { projectId: string }).projectId, "p1");
      assert.equal((projects[0] as { status: string }).status, "indexing");
    } finally {
      await r.cleanup();
    }
  });

  void it("honours --model and repins the sidecar to the requested dimension", async () => {
    const r = await rig({ startDim: 4 });
    try {
      const res = await post(r.port, { model: "fake:8" });
      const body = (await res.json()) as { model: string; dim: number };
      assert.equal(res.status, 200, JSON.stringify(body));

      // The old handler accepted {model} and embedded with the current model
      // anyway, so this is the regression that matters most.
      assert.deepEqual(r.rebuilds, ["fake:8"], "the requested model never reached the rebuild");
      assert.equal(body.model, "fake:8");
      assert.equal(body.dim, 8);

      const pinned = readEmbeddingSidecar(r.dbPath);
      assert.equal(pinned?.model, "fake:8");
      assert.equal(pinned?.dim, 8, "a fixed-width vector column cannot absorb this in place");
    } finally {
      await r.cleanup();
    }
  });

  void it("is the way out of a model mismatch, not another refusal", async () => {
    // ADR-015 §2 keeps a mismatched daemon alive solely so this call can work.
    // It used to answer 503 'no embedding provider is available', whose remedy
    // was to run the command that had just failed.
    const r = await rig({ degraded: true });
    try {
      const before = await fetch(`http://127.0.0.1:${r.port}/health`);
      assert.equal(((await before.json()) as { status: string }).status, "mismatch");

      const res = await post(r.port, {});
      assert.equal(res.status, 200, await res.text());

      // Degraded mode is over: the daemon serves the full surface again.
      const after = await fetch(`http://127.0.0.1:${r.port}/health`);
      assert.equal(((await after.json()) as { status: string }).status, "ok");

      const search = await fetch(`http://127.0.0.1:${r.port}/search`, {
        method: "POST", headers: HEADERS, body: JSON.stringify({ query: "x", projectId: "p1" }),
      });
      assert.notEqual(search.status, 409, "/search is still refused after a successful rebuild");
    } finally {
      await r.cleanup();
    }
  });

  void it("rejects a malformed model instead of silently using the current one", async () => {
    const r = await rig();
    try {
      for (const bad of [{ model: "" }, { model: 7 }]) {
        const res = await post(r.port, bad);
        assert.equal(res.status, 400, `accepted ${JSON.stringify(bad)}`);
        const env = (await res.json()) as { error: { code: string } };
        assert.equal(env.error.code, "INVALID_REQUEST");
      }
      assert.deepEqual(r.rebuilds, [], "a rejected request still triggered a rebuild");
    } finally {
      await r.cleanup();
    }
  });

  void it("reports a failed rebuild instead of 200 with a zeroed counter", async () => {
    const root = mkdtempSync(join(tmpdir(), "prag-reembed-fail-"));
    const daemon = new Daemon({ port: 0, token: TOKEN, noExit: true });
    await daemon.start(null, null, {
      mismatch: new DaemonFailure("EMBEDDING_MODEL_MISMATCH", "stale", "Run `prag reembed`."),
      rebuild: async () => { throw new Error("weights would not load"); },
    });
    try {
      const res = await post(daemon.boundPort!, {});
      assert.equal(res.status, 500);
      const env = (await res.json()) as { error: { code: string; message: string } };
      assert.equal(env.error.code, "INTERNAL");
      // ADR-022 §4: 500 may name internals, but never the raw throw site.
      assert.ok(!env.error.message.includes("weights would not load"));
    } finally {
      await daemon.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("refuses a second rebuild while one is running", async () => {
    const root = mkdtempSync(join(tmpdir(), "prag-reembed-busy-"));
    const daemon = new Daemon({ port: 0, token: TOKEN, noExit: true });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    await daemon.start(null, null, {
      mismatch: new DaemonFailure("EMBEDDING_MODEL_MISMATCH", "stale", "Run `prag reembed`."),
      rebuild: async () => { await gate; throw new Error("done"); },
    });
    try {
      const first = post(daemon.boundPort!, {});
      // Let the first request reach the hook before the second arrives.
      await new Promise((r) => setTimeout(r, 50));
      const second = await post(daemon.boundPort!, {});
      assert.equal(second.status, 409);
      const env = (await second.json()) as { error: { code: string } };
      assert.equal(env.error.code, "REEMBED_IN_PROGRESS");
      release();
      await first;
    } finally {
      await daemon.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

void describe("POST /reembed — ADR-015 drop and requeue", reembedSuite);
