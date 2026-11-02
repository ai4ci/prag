// @prag/daemon — End-to-end test: daemon with ingestion
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

import { LanceDbSchema, FakeEmbeddingProvider } from "@prag/core";
import { Daemon } from "../src/daemon.js";

interface SyncBody {
  ok: boolean;
  flushedFiles: number;
  pendingFiles: number;
  failedFiles: string[];
}

/**
 * POST /sync until the queue reports itself drained.
 *
 * A drain only guarantees "everything observed so far is written"; an event the
 * watcher delivers *during* the drain legitimately leaves it non-empty (HTTP 202),
 * which is exactly what a burst of writes does. Callers handle that by syncing
 * again, so the helper does too — and fails loudly if it never settles.
 */
async function syncUntilDrained(
  port: number,
  projectId: string,
  headers: Record<string, string>,
  attempts = 5,
): Promise<SyncBody> {
  let last: SyncBody | undefined;
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(`http://127.0.0.1:${port}/sync`, {
      method: "POST",
      headers,
      body: JSON.stringify({ projectId }),
    });
    if (res.status === 504) {
      throw new Error(`SYNC_TIMEOUT: ${await res.text()}`);
    }
    last = (await res.json()) as SyncBody;
    if (last.ok) return last;
  }
  return last!;
}

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

    // No sleep: /sync is a drain barrier and waits for the initial scan.
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
  void it("syncs a project just registered with no sleep", async () => {
    // The ADR-019 contract in the form a harness actually needs: index a corpus,
    // sync, assert — with no `await sleep()` anywhere. Before the scan barrier
    // existed, /sync could answer "drained" before chokidar had even enumerated
    // the tree, which is why every harness slept.
    const port = ctx.searchedPort!;
    const headers = {
      "Content-Type": "application/json",
      Authorization: "Bearer test-ingest",
    };

    const otherDir = join(ctx.tmpDir, "scan-first");
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(otherDir, "debounce.ts"), [
      "export function debouncedFlush(queue: Queue) {",
      "  return queue.drain();",
      "}",
    ].join("\n"));

    const reg = await fetch(`http://127.0.0.1:${port}/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ projectId: "scan-first", rootUri: otherDir }),
    });
    assert.equal(reg.status, 200);

    const syncRes = await fetch(`http://127.0.0.1:${port}/sync`, {
      method: "POST",
      headers,
      body: JSON.stringify({ projectId: "scan-first" }),
    });
    const sync = (await syncRes.json()) as {
      ok: boolean;
      flushedFiles: number;
      pendingFiles: number;
    };
    assert.ok(
      syncRes.status === 200 || syncRes.status === 202,
      `unexpected status ${syncRes.status}: ${JSON.stringify(sync)}`,
    );
    assert.ok(sync.ok, `sync did not drain: ${JSON.stringify(sync)}`);
    assert.equal(sync.pendingFiles, 0);
    assert.ok(sync.flushedFiles >= 1, `flushed nothing: ${JSON.stringify(sync)}`);

    // Immediately, with no delay: the index must already reflect the disk.
    const searchRes = await fetch(`http://127.0.0.1:${port}/search`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: "debounce drain the queue", projectId: "scan-first", limit: 10 }),
    });
    const body = (await searchRes.json()) as { hits: Array<{ uri: string }> };
    assert.ok(
      body.hits.some((h) => h.uri.endsWith("debounce.ts")),
      `debounce.ts missing right after /sync: ${body.hits.map((h) => h.uri).join(", ")}`,
    );

    // And scoping holds: the other project's files must not leak in here.
    assert.ok(
      body.hits.every((h) => h.uri.startsWith(otherDir)),
      `cross-project leak into a scoped search: ${body.hits.map((h) => h.uri).join(", ")}`,
    );
  });

  void it("forces a flush past an outstanding cooldown lease", async () => {
    // ADR-008: /sync must flush every dirty URI regardless of its validUntil
    // lease, and must not leave the lease in a state that swallows the *next*
    // change. With a 60s debounce nothing would be indexed on its own, so this
    // can only pass if the drain really forces it.
    const headers = {
      "Content-Type": "application/json",
      Authorization: "Bearer test-lease",
    };
    const leaseDir = mkdtempSync(join(tmpdir(), "prag-lease-"));
    const leaseDaemon = new Daemon({
      port: 0,
      token: "test-lease",
      noExit: true,
      ingestion: { poolSize: 1, cooldownMs: 60_000 },
    });
    try {
      writeFileSync(join(leaseDir, "first.ts"), "export const first = 1;\n");
      await leaseDaemon.start(ctx.schema!, new FakeEmbeddingProvider(4));
      const port = leaseDaemon.boundPort!;

      const reg = await fetch(`http://127.0.0.1:${port}/projects`, {
        method: "POST",
        headers,
        body: JSON.stringify({ projectId: "lease-test", rootUri: leaseDir }),
      });
      assert.equal(reg.status, 200);

      // Now a change lands while the 60s lease is armed, and we sync immediately.
      writeFileSync(join(leaseDir, "second.ts"), "export const second = 2;\n");

      const sync = await (await fetch(`http://127.0.0.1:${port}/sync`, {
        method: "POST",
        headers,
        body: JSON.stringify({ projectId: "lease-test" }),
      })).json();
      assert.ok(sync.ok, `lease suppressed the drain: ${JSON.stringify(sync)}`);

      const hits = async () => {
        const res = await fetch(`http://127.0.0.1:${port}/search`, {
          method: "POST",
          headers,
          body: JSON.stringify({ query: "export const", projectId: "lease-test", limit: 10 }),
        });
        return ((await res.json()) as { hits: Array<{ uri: string }> }).hits.map((h) => h.uri);
      };

      const uris = await hits();
      assert.ok(uris.some((u) => u.endsWith("second.ts")), `lease blocked indexing: ${uris}`);

      // A third file must still be ingestible afterwards: forcing the flush must
      // not have left a lease that suppresses the next event. Synced rather than
      // slept on, because the 60s debounce means it would not land on its own.
      writeFileSync(join(leaseDir, "third.ts"), "export const third = 3;\n");
      await sleep(100); // let the watcher event reach the dirty set
      const sync2 = await (await fetch(`http://127.0.0.1:${port}/sync`, {
        method: "POST",
        headers,
        body: JSON.stringify({ projectId: "lease-test" }),
      })).json();
      assert.ok(sync2.ok, `second drain did not settle: ${JSON.stringify(sync2)}`);
      const after = await hits();
      assert.ok(
        after.some((u) => u.endsWith("third.ts")),
        `event after a forced flush was swallowed: ${after}`,
      );
    } finally {
      await leaseDaemon.stop();
      rmSync(leaseDir, { recursive: true, force: true });
    }
  });

  void it("survives a hundred write/sync/assert cycles with no sleeps", async () => {
    // The verification ADR-019 asks for: run the write/sync/assert cycle many
    // times and observe zero flakes. The earlier harness needed a sleep after
    // each write because /sync sampled the dirty set before chokidar delivered
    // the event, and reconciling against disk is what makes the loop sound.
    // 25 iterations in-suite (~1s each: every write is a LanceDB commit); the
    // spec's several hundred is run via PRAG_SYNC_LOOP=300 before touching this
    // path, not on every commit.
    const iterations = Number(process.env.PRAG_SYNC_LOOP ?? 25);
    const headers = {
      "Content-Type": "application/json",
      Authorization: "Bearer test-loop",
    };
    const loopDir = mkdtempSync(join(tmpdir(), "prag-loop-"));
    const loopDaemon = new Daemon({
      port: 0,
      token: "test-loop",
      noExit: true,
      ingestion: { poolSize: 2, cooldownMs: 25 },
    });
    try {
      writeFileSync(join(loopDir, "seed.ts"), "export const seed = 0;\n");
      await loopDaemon.start(ctx.schema!, new FakeEmbeddingProvider(4));
      const port = loopDaemon.boundPort!;

      const reg = await fetch(`http://127.0.0.1:${port}/projects`, {
        method: "POST",
        headers,
        body: JSON.stringify({ projectId: "loop-test", rootUri: loopDir }),
      });
      assert.equal(reg.status, 200);

      const target = join(loopDir, "cycle.ts");
      for (let i = 0; i < iterations; i++) {
        writeFileSync(target, `export const cycle = ${i};\n`);
        const sync = await syncUntilDrained(port, "loop-test", headers);
        assert.ok(sync.ok, `iteration ${i}: ${JSON.stringify(sync)}`);

        const res = await fetch(`http://127.0.0.1:${port}/search`, {
          method: "POST",
          headers,
          body: JSON.stringify({ query: "cycle", projectId: "loop-test", limit: 10 }),
        });
        const hits = ((await res.json()) as { hits: Array<{ uri: string }> }).hits;
        assert.ok(
          hits.some((h) => h.uri.endsWith("cycle.ts")),
          `iteration ${i}: cycle.ts absent from ${hits.map((h) => h.uri)}`,
        );
      }
    } finally {
      await loopDaemon.stop();
      rmSync(loopDir, { recursive: true, force: true });
    }
  });

  void it("returns SYNC_TIMEOUT instead of hanging when the drain cannot finish", async () => {
    // ADR-019 says: name what is outstanding rather than hang or return success.
    const headers = {
      "Content-Type": "application/json",
      Authorization: "Bearer test-timeout",
    };
    const timeoutDir = mkdtempSync(join(tmpdir(), "prag-sync-to-"));
    const slowDaemon = new Daemon({
      port: 0,
      token: "test-timeout",
      noExit: true,
      ingestion: { poolSize: 1, cooldownMs: 10, syncTimeoutMs: 1 },
    });
    try {
      await slowDaemon.start(ctx.schema!, new FakeEmbeddingProvider(4));
      const port = slowDaemon.boundPort!;

      writeFileSync(join(timeoutDir, "pending.ts"), "export const pending = 1;\n");
      const reg = await fetch(`http://127.0.0.1:${port}/projects`, {
        method: "POST",
        headers,
        body: JSON.stringify({ projectId: "timeout-test", rootUri: timeoutDir }),
      });
      assert.equal(reg.status, 200);

      const syncRes = await fetch(`http://127.0.0.1:${port}/sync`, {
        method: "POST",
        headers,
        body: JSON.stringify({ projectId: "timeout-test" }),
      });
      assert.equal(syncRes.status, 504, `expected 504, got ${syncRes.status}`);

      const env = (await syncRes.json()) as {
        error: { code: string; message: string; details?: Record<string, unknown> };
      };
      assert.equal(env.error.code, "SYNC_TIMEOUT");
      assert.match(env.error.message, /1ms|timed out/i, env.error.message);
      assert.ok(
        typeof env.error.details?.pendingFiles === "number",
        `details missing pendingFiles: ${JSON.stringify(env.error.details)}`,
      );
    } finally {
      await slowDaemon.stop();
      rmSync(timeoutDir, { recursive: true, force: true });
    }
  });
}
void describe("Daemon with ingestion", daemonWithIngestionSuite);
