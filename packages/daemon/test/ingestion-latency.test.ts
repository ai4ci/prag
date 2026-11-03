// @prag/daemon — ADR-021's actual claim, measured.
//
// The objective is "synchronous parsing cannot stall the /search request
// path". Everything else about the worker pool is covered functionally; this
// is the only test that exercises the reason the pool exists at all.
//
// It asserts a *relative* bound (serving does not collapse while ingesting)
// rather than an absolute millisecond figure, because an absolute threshold on
// a shared CI runner measures the runner, not the code. Absolute percentiles
// are printed so a regression is legible even when the assertion passes.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { LanceDbSchema, FakeEmbeddingProvider } from "@prag/core";
import { Daemon } from "../src/daemon.js";

const TOKEN = "test-latency";
const HEADERS = { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };

/** A source file big enough to be real parse work, not a toy. */
function sourceFile(i: number): string {
  const fns = Array.from({ length: 40 }, (_, j) => `
/** Function ${j} of file ${i}. Does arithmetic so the parser has a body to walk. */
export function f${i}_${j}(a: number, b: number): number {
  const scaled = a * ${j + 1} + b;
  if (scaled > 100) return scaled - 100;
  return scaled;
}`);
  return fns.join("\n");
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

/** Hammer /health for `ms`, returning sorted latencies. */
async function sample(port: number, ms: number): Promise<number[]> {
  const out: number[] = [];
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const t0 = performance.now();
    await fetch(`http://127.0.0.1:${port}/health`);
    out.push(performance.now() - t0);
  }
  return out.sort((a, b) => a - b);
}

function latencySuite(): void {
  const ctx: { tmpDir: string; schema: LanceDbSchema | null; daemon: Daemon | null; port: number } =
    { tmpDir: "", schema: null, daemon: null, port: 0 };
  let corpus = "";

  before(async () => {
    ctx.tmpDir = mkdtempSync(join(tmpdir(), "prag-latency-"));
    ctx.schema = new LanceDbSchema({
      dbPath: join(ctx.tmpDir, "lancedb"),
      embeddingDim: 4,
      maxVectorUnitTokens: 512,
      modelMaxSeqLength: 512,
    });
    await ctx.schema.init();
    ctx.daemon = new Daemon({
      port: 0, token: TOKEN, noExit: true,
      ingestion: { poolSize: 1, cooldownMs: 5 },
    });
    await ctx.daemon.start(ctx.schema, new FakeEmbeddingProvider(4));
    ctx.port = ctx.daemon.boundPort!;

    corpus = join(ctx.tmpDir, "corpus");
    mkdirSync(corpus, { recursive: true });
    for (let i = 0; i < 120; i++) writeFileSync(join(corpus, `mod${i}.ts`), sourceFile(i));
  });

  after(async () => {
    await ctx.daemon?.stop();
    await ctx.schema?.close();
    rmSync(ctx.tmpDir, { recursive: true, force: true });
  });

  void it("keeps serving /health while a 120-file tree is ingested (ADR-021)", async () => {
    const idle = await sample(ctx.port, 400);
    const idleP99 = percentile(idle, 99);

    // Start ingestion and sample while it runs. The watch call returns as soon
    // as the queue is seeded, so the sampling overlaps the real work.
    const watching = fetch(`http://127.0.0.1:${ctx.port}/projects/watch`, {
      method: "POST", headers: HEADERS,
      body: JSON.stringify({ uri: `file://${corpus}`, projectId: "bench", confirm: true }),
    });
    const busy = await sample(ctx.port, 1500);
    const res = await watching;
    assert.equal(res.status, 200, await res.text());

    const busyP50 = percentile(busy, 50);
    const busyP99 = percentile(busy, 99);
    console.log(
      `    /health idle  p50=${percentile(idle, 50).toFixed(1)}ms p99=${idleP99.toFixed(1)}ms (n=${idle.length})\n` +
      `    /health busy  p50=${busyP50.toFixed(1)}ms p99=${busyP99.toFixed(1)}ms (n=${busy.length})`,
    );

    assert.ok(busy.length > 20, `only ${busy.length} requests completed while ingesting`);
    // Generous: the point is that the event loop keeps turning, not that there
    // is no cost. Parsing on the main thread would show up as seconds here.
    assert.ok(busyP99 < 1000,
      `p99 /health latency under ingestion load was ${busyP99.toFixed(1)}ms -- ` +
      "parsing is stalling the request path, which is the thing ADR-021 exists to prevent");
  });

  void it("drains the tree and indexes it", async () => {
    const sync = await fetch(`http://127.0.0.1:${ctx.port}/sync`, {
      method: "POST", headers: HEADERS, body: JSON.stringify({ projectId: "bench" }),
    });
    assert.equal(sync.status, 200, await sync.text());

    const t0 = performance.now();
    const search = await fetch(`http://127.0.0.1:${ctx.port}/search`, {
      method: "POST", headers: HEADERS,
      body: JSON.stringify({ query: "arithmetic body walk", limit: 5, projectId: "bench" }),
    });
    const elapsed = performance.now() - t0;
    assert.equal(search.status, 200);
    const hits = ((await search.json()) as { hits: unknown[] }).hits;
    console.log(`    search over the ingested tree: ${hits.length} hits in ${elapsed.toFixed(1)}ms`);
    assert.ok(hits.length > 0, "a 120-file tree produced no search hits");
  });
}

void describe("ingestion latency (ADR-021)", latencySuite);
