// @prag/daemon — Watch admission control, grant-gated ingestion and pause (ADR-009, ADR-023)
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { LanceDbSchema, FakeEmbeddingProvider } from "@prag/core";
import { Daemon } from "../src/daemon.js";

const HEADERS = {
  "Content-Type": "application/json",
  Authorization: "Bearer test-admission",
};

async function json(port: number, path: string, body?: unknown, method = "POST") {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: HEADERS,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(await res.text());
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, body: parsed as Record<string, any> };
}

/**
 * URIs a search returns, scoped to one project.
 *
 * Scoped deliberately. Every test in this suite shares one daemon and one
 * index, so an unscoped `limit: 20` ranks this project's files against
 * everything the earlier tests indexed -- and the file under test can fall
 * out of the top 20 depending on what ran before it. That made this suite
 * fail about one run in three under full-suite load and pass in isolation.
 * It also makes the negative assertions mean something: "the secret is not in
 * these results" is worth little when the results are another project's.
 */
async function urisFor(port: number, query: string, projectId?: string): Promise<string[]> {
  const res = await json(port, "/search", { query, limit: 20, ...(projectId ? { projectId } : {}) });
  return ((res.body?.hits ?? []) as Array<{ uri: string }>).map((h) => h.uri);
}

function watchAdmissionSuite(): void {
  const ctx: {
    tmpDir: string;
    schema: LanceDbSchema | null;
    daemon: Daemon | null;
    port: number;
  } = { tmpDir: "", schema: null, daemon: null, port: 0 };

  after(async () => {
    await ctx.daemon?.stop();
    await ctx.schema?.close();
    if (ctx.tmpDir) rmSync(ctx.tmpDir, { recursive: true, force: true });
    await new Promise((r) => setImmediate(r));
  });

  void it("/projects/watch refuses a tree past the threshold and changes nothing", async () => {
    ctx.tmpDir = mkdtempSync(join(tmpdir(), "prag-admission-"));
    ctx.schema = new LanceDbSchema({
      dbPath: ctx.tmpDir,
      embeddingDim: 4,
      maxVectorUnitTokens: 512,
      modelMaxSeqLength: 512,
    });
    await ctx.schema.init();
    ctx.daemon = new Daemon({
      port: 0,
      token: "test-admission",
      noExit: true,
      // Threshold of 1 file so the refusal path is reachable with two files.
      ingestion: { poolSize: 1, cooldownMs: 20, watchConfirmThreshold: { projects: 1, files: 1 } },
    });
    await ctx.daemon.start(ctx.schema, new FakeEmbeddingProvider(4));
    ctx.port = ctx.daemon.boundPort!;

    const big = join(ctx.tmpDir, "big");
    mkdirSync(big, { recursive: true });
    writeFileSync(join(big, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(big, "b.ts"), "export const b = 2;\n");

    const res = await json(ctx.port, "/projects/watch", {
      uri: `file://${big}`,
      projectId: "big-project",
    });
    assert.equal(res.status, 409, `expected refusal, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error.code, "WATCH_LIMIT_EXCEEDED");
    assert.equal(res.body.error.details.files, 2);
    assert.equal(res.body.error.details.projects, 1);

    // ADR-023: a refusal must not half-apply. No grant, no project, no watcher.
    const grants = await json(ctx.port, "/grants", undefined, "GET");
    assert.deepEqual(grants.body, [], "a grant was written despite the refusal");
    const projects = await json(ctx.port, "/projects", undefined, "GET");
    assert.equal((projects.body as unknown[]).length, 0);
  });

  void it("--yes (confirm) registers the project and indexes the tree", async () => {
    const big = join(ctx.tmpDir, "big");
    const res = await json(ctx.port, "/projects/watch", {
      uri: `file://${big}`,
      projectId: "big-project",
      confirm: true,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.discovered.files, 2);
    assert.equal(res.body.discovered.projects, 1);

    const grants = (await json(ctx.port, "/grants", undefined, "GET")).body as Array<{
      pattern: string;
      action: string;
    }>;
    assert.ok(
      grants.some((g) => g.action === "allow" && g.pattern.startsWith(`file://${big}`)),
      `no allow grant: ${JSON.stringify(grants)}`,
    );

    const sync = await json(ctx.port, "/sync", { projectId: "big-project" });
    assert.equal(sync.status, 200, JSON.stringify(sync.body));

    const uris = await urisFor(ctx.port, "anything", "big-project");
    for (const name of ["a.ts", "b.ts"]) {
      assert.ok(
        uris.some((u) => u.endsWith(name)),
        `${name} not indexed after confirm: sync=${JSON.stringify(sync.body)} ` +
          `uris=${uris.join(", ")} skipped=${JSON.stringify(
            (await json(ctx.port, "/projects", undefined, "GET")).body,
          )}`,
      );
    }
  });

  void it("prag deny purges indexed files and stops the watcher", async () => {
    const deny = await json(ctx.port, "/grants", {
      pattern: `file://${join(ctx.tmpDir, "big")}/b.ts/**`,
      action: "deny",
    });
    assert.equal(deny.status, 200, JSON.stringify(deny.body));
    assert.equal(deny.body.purgedFiles, 1, JSON.stringify(deny.body));

    const uris = await urisFor(ctx.port, "anything", "big-project");
    assert.ok(
      !uris.some((u) => u.endsWith("b.ts")),
      `denied file still searchable: ${uris.join(", ")}`,
    );
    assert.ok(uris.some((u) => u.endsWith("a.ts")), "sibling file was collateral damage");

    // A new write under the denied path must never be read or indexed.
    writeFileSync(join(ctx.tmpDir, "big", "b.ts"), "export const b = 999;\n");
    const sync = await json(ctx.port, "/sync", { projectId: "big-project" });
    assert.equal(sync.status, 200);
    const after = await urisFor(ctx.port, "anything", "big-project");
    assert.ok(!after.some((u) => u.endsWith("b.ts")), "denied path was re-indexed after sync");

    const projects = (await json(ctx.port, "/projects", undefined, "GET")).body as Array<{
      projectId: string;
      skipped: Record<string, number>;
    }>;
    assert.ok(
      (projects.find((p) => p.projectId === "big-project")?.skipped.denied ?? 0) >= 1,
      `denied counter never incremented: ${JSON.stringify(projects)}`,
    );
  });

  void it("a denied directory is skipped at discovery, before its files are read", async () => {
    const root = join(ctx.tmpDir, "with-secret");
    mkdirSync(join(root, "secrets"), { recursive: true });
    writeFileSync(join(root, "index.ts"), "export const idx = 1;\n");
    writeFileSync(join(root, "secrets", "token.txt"), "hunter2\n");

    await json(ctx.port, "/grants", {
      pattern: `file://${join(root, "secrets")}/**`,
      action: "deny",
    });

    const watch = await json(ctx.port, "/projects/watch", {
      uri: `file://${root}`,
      projectId: "with-secret",
      confirm: true,
    });
    assert.equal(watch.status, 200, JSON.stringify(watch.body));
    // The dry run counts the denied subtree as excluded, not as indexable.
    assert.equal(watch.body.discovered.files, 1, JSON.stringify(watch.body.discovered));

    await json(ctx.port, "/sync", { projectId: "with-secret" });
    const uris = await urisFor(ctx.port, "anything", "with-secret");
    assert.ok(uris.some((u) => u.endsWith("index.ts")),
      `the project's own file was not indexed: ${uris.join(", ")}`);
    assert.ok(!uris.some((u) => u.includes("token.txt")), `secret was indexed: ${uris.join(", ")}`);
  });

  void it("pause stops ingestion and resume continues it", async () => {
    const root = join(ctx.tmpDir, "pausable");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "first.ts"), "export const first = 1;\n");

    const watch = await json(ctx.port, "/projects/watch", {
      uri: `file://${root}`,
      projectId: "pausable",
      confirm: true,
    });
    assert.equal(watch.status, 200, JSON.stringify(watch.body));
    await json(ctx.port, "/sync", { projectId: "pausable" });

    // Pause, then write while paused.
    const pause = await json(ctx.port, "/pause", { projectId: "pausable" });
    assert.equal(pause.status, 200);
    writeFileSync(join(root, "second.ts"), "export const second = 2;\n");

    const paused = await json(ctx.port, "/sync", { projectId: "pausable" });
    assert.equal(paused.status, 200, JSON.stringify(paused.body));
    // ADR-023: while paused, events are dropped rather than queued.
    assert.equal(paused.body.flushedFiles, 0, JSON.stringify(paused.body));
    let uris = await urisFor(ctx.port, "anything", "pausable");
    assert.ok(!uris.some((u) => u.endsWith("second.ts")), "indexed while paused");

    const resume = await json(ctx.port, "/resume", { projectId: "pausable" });
    assert.equal(resume.status, 200);
    const resumed = await json(ctx.port, "/sync", { projectId: "pausable" });
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    uris = await urisFor(ctx.port, "anything", "pausable");
    assert.ok(
      uris.some((u) => u.endsWith("second.ts")),
      `second.ts missing after resume: ${uris.join(", ")}`,
    );
  });

  void it("a non-file URI needs a fetch backend instead of silently succeeding", async () => {
    const res = await json(ctx.port, "/projects/watch", { uri: "https://docs.lancedb.com/**" });
    assert.equal(res.status, 503, JSON.stringify(res.body));
    assert.equal(res.body.error.code, "CRAWL_BACKEND_REQUIRED");
  });
}
void describe("watch admission control", watchAdmissionSuite);
