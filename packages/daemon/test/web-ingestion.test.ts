// @prag/daemon — ADR-024 web ingestion: fetch a granted URL, index it under
// the site's project, and hold it under an ADR-008 freshness lease.
//
// Everything runs against a loopback HTTP server. No test here reaches the
// network, and the local-first egress suite asserts separately that a local
// index+search cycle stays silent even with a backend configured.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";

import {
  LanceDbSchema, FakeEmbeddingProvider, upsertGrants, DaemonFailure,
  type WebFetchBackend, type WebCapability, type FreshnessHint,
} from "@prag/core";
import { Daemon } from "../src/daemon.js";

/** A backend that serves the loopback origin and reports a chosen freshness. */
function backendFor(freshness: () => FreshnessHint): WebFetchBackend {
  return {
    id: "test-fetcher",
    endpoint: "(loopback)",
    capabilities: new Set<WebCapability>(["fetch"]),
    async fetch(url) {
      const res = await globalThis.fetch(url);
      if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
      return { url: res.url || url, text: await res.text(), contentType: "text/markdown", freshness: freshness() };
    },
  };
}

function webIngestionSuite(): void {
  let server: Server;
  let origin = "";
  let body = "# Guide\n\nThe vector pool deduplicates content by chunk hash.\n";
  const ctx: { tmp: string; schema: LanceDbSchema | null; daemon: Daemon | null } =
    { tmp: "", schema: null, daemon: null };
  let freshness: FreshnessHint = { kind: "live" };

  before(async () => {
    server = createServer((req, res) => {
      if (req.url === "/denied") { res.writeHead(200, { "content-type": "text/markdown" }).end("# Secret\n"); return; }
      res.writeHead(200, { "content-type": "text/markdown" }).end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(async () => { await new Promise<void>((r) => server.close(() => r())); });

  beforeEach(async () => {
    await ctx.daemon?.stop();
    await ctx.schema?.close();
    if (ctx.tmp) rmSync(ctx.tmp, { recursive: true, force: true });
    ctx.tmp = mkdtempSync(join(tmpdir(), "prag-web-"));
    ctx.schema = new LanceDbSchema({
      dbPath: join(ctx.tmp, "db"), embeddingDim: 4, maxVectorUnitTokens: 512, modelMaxSeqLength: 512,
    });
    await ctx.schema.init();
    ctx.daemon = new Daemon({
      port: 0, token: "t", noExit: true,
      webBackend: backendFor(() => freshness),
      webCooldownSeconds: 3600,
    });
    await ctx.daemon.start(ctx.schema, new FakeEmbeddingProvider(4));
    await upsertGrants(ctx.schema.table("grants"), [
      { pattern: `${origin}/**`, action: "allow", reason: "explicit_grant", createdAt: new Date() },
      { pattern: `${origin}/denied`, action: "deny", reason: "user_deny", createdAt: new Date() },
    ]);
    ctx.daemon.invalidateGrantCache();
    freshness = { kind: "live" };
  });

  after(async () => {
    await ctx.daemon?.stop();
    await ctx.schema?.close();
    if (ctx.tmp) rmSync(ctx.tmp, { recursive: true, force: true });
  });

  const rows = async () =>
    (await ctx.schema!.table("file_mapping").query().limit(50).toArray()) as
      Array<{ uri: string; projectId: string; validUntil: Date | null; contentHash: string }>;

  void it("indexes a granted URL under the site's project id", async () => {
    const out = await ctx.daemon!.ingestWebUri(`${origin}/guide`);
    assert.equal(out.indexed, true, JSON.stringify(out));

    const [row] = await rows();
    assert.ok(row, "nothing was written");
    // Every page of a site is one project, so a search can be scoped to the
    // site rather than to a single page.
    assert.equal(row.projectId, origin);
    assert.equal(row.uri, `${origin}/guide`);
  });

  void it("refuses a denied URL without fetching it as an error", async () => {
    // A crawl legitimately turns up excluded URLs; that is policy working,
    // not a failure, so it must not read as one.
    const out = await ctx.daemon!.ingestWebUri(`${origin}/denied`);
    assert.equal(out.indexed, false);
    assert.equal(out.reason, "denied");
    assert.equal((await rows()).length, 0, "a denied URL was indexed anyway");
  });

  void it("gives a cached copy the remaining lease, not a full one", async () => {
    // ADR-024: the content was already ageSeconds old on arrival. A full
    // window would make the index staler than the configured policy allows.
    freshness = { kind: "cached", ageSeconds: 3000 };
    await ctx.daemon!.ingestWebUri(`${origin}/guide`);
    const [row] = await rows();
    const remaining = (new Date(row.validUntil!).getTime() - Date.now()) / 1000;
    assert.ok(remaining < 700, `cached copy got ${remaining.toFixed(0)}s, expected ~600s`);
    assert.ok(remaining > 500, `cached copy got ${remaining.toFixed(0)}s, expected ~600s`);
  });

  void it("refuses when the backend cannot fetch, by code", async () => {
    const noFetch = new Daemon({
      port: 0, token: "t", noExit: true,
      webBackend: { id: "discover-only", endpoint: "x", capabilities: new Set<WebCapability>(["discover"]) },
    });
    await noFetch.start(ctx.schema, new FakeEmbeddingProvider(4));
    try {
      await assert.rejects(
        () => noFetch.ingestWebUri(`${origin}/guide`),
        (err: unknown) => {
          assert.ok(err instanceof DaemonFailure);
          assert.equal(err.code, "CRAWL_CAPABILITY_UNAVAILABLE");
          return true;
        },
      );
    } finally {
      await noFetch.stop();
    }
  });

  void it("re-fetches only expired leases, and re-indexes only changed content", async () => {
    await ctx.daemon!.ingestWebUri(`${origin}/guide`);
    const before = (await rows())[0]!;

    // Nothing is due yet: the lease has an hour to run.
    const none = await ctx.daemon!.refreshExpiredWebContent();
    assert.equal(none.checked, 0, "a live lease was re-fetched early");

    // Due, but the page has not changed: one fetch, no re-index.
    const future = new Date(Date.now() + 2 * 3600 * 1000);
    const unchanged = await ctx.daemon!.refreshExpiredWebContent(future);
    assert.equal(unchanged.checked, 1);
    assert.equal(unchanged.reindexed, 0, "unchanged content was re-embedded");

    // Changed at the origin: now it must re-index.
    body = "# Guide\n\nRewritten: reciprocal rank fusion merges the two arms.\n";
    const changed = await ctx.daemon!.refreshExpiredWebContent(future);
    assert.equal(changed.reindexed, 1, "changed content was not re-indexed");
    const after = (await rows()).find((r) => r.uri === before.uri)!;
    assert.notEqual(after.contentHash, before.contentHash);
  });

  void it("POST /projects/watch on a page URL grants it and indexes it", async () => {
    const port = ctx.daemon!.boundPort!;
    const res = await fetch(`http://127.0.0.1:${port}/projects/watch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
      body: JSON.stringify({ uri: `${origin}/guide` }),
    });
    const out = (await res.json()) as Record<string, any>;
    assert.equal(res.status, 200, JSON.stringify(out));
    assert.equal(out.projectId, origin);
    assert.deepEqual(out.registered, [origin]);

    // And it is searchable under the site's project.
    const search = await fetch(`http://127.0.0.1:${port}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
      body: JSON.stringify({ query: "vector pool", limit: 5, projectId: origin }),
    });
    const hits = ((await search.json()) as { hits: Array<{ uri: string }> }).hits;
    assert.ok(hits.some((h) => h.uri === `${origin}/guide`),
      `the watched page is not searchable: ${JSON.stringify(hits.map((h) => h.uri))}`);
  });

  void it("a bare origin asks for discover and says crawling is unimplemented", async () => {
    // The fetch/discover split has to be decided from the URL alone: a bare
    // origin means the site, a path means one document.
    const port = ctx.daemon!.boundPort!;
    const res = await fetch(`http://127.0.0.1:${port}/projects/watch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
      body: JSON.stringify({ uri: origin }),
    });
    const out = (await res.json()) as { error: { code: string } };
    assert.equal(out.error.code, "CRAWL_CAPABILITY_UNAVAILABLE");
  });
}

void describe("web ingestion (ADR-024)", webIngestionSuite);
