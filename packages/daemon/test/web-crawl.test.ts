// @prag/daemon — the crawl half of task:web-ingestion-pipeline.md.
//
// `discover` names a site's URLs; this asserts that the fan-out to
// `ingestWebUri` re-applies the grants, survives a failing page, and respects
// its page bound. The real crawlberg backend runs against a loopback origin,
// so the sitemap parsing and HTML->Markdown conversion under test are the
// ones that will run in production, not a stub's idea of them.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";

import { LanceDbSchema, FakeEmbeddingProvider, upsertGrants } from "@prag/core";
import { Daemon } from "../src/daemon.js";
import { makeCrawlbergBackend } from "../src/crawlberg-backend.js";

function page(title: string, body: string): string {
  return `<!doctype html><html><head><title>${title}</title></head>
    <body><h1>${title}</h1><p>${body}</p></body></html>`;
}

function webCrawlSuite(): void {
  let server: Server;
  let origin = "";
  const ctx: { tmp: string; schema: LanceDbSchema | null; daemon: Daemon | null } =
    { tmp: "", schema: null, daemon: null };

  before(async () => {
    server = createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nAllow: /\n");
        return;
      }
      if (path === "/sitemap.xml") {
        res.writeHead(200, { "content-type": "application/xml" }).end(
          `<?xml version="1.0" encoding="UTF-8"?>
           <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
             <url><loc>${origin}/guide</loc></url>
             <url><loc>${origin}/reference</loc></url>
             <url><loc>${origin}/private</loc></url>
             <url><loc>${origin}/broken</loc></url>
           </urlset>`);
        return;
      }
      if (path === "/broken") { res.writeHead(500).end("boom"); return; }
      if (path === "/guide") {
        res.writeHead(200, { "content-type": "text/html" })
          .end(page("Guide", "The vector pool deduplicates content by chunk hash."));
        return;
      }
      if (path === "/reference") {
        res.writeHead(200, { "content-type": "text/html" })
          .end(page("Reference", "Every file mapping row carries a project id."));
        return;
      }
      if (path === "/private") {
        res.writeHead(200, { "content-type": "text/html" })
          .end(page("Private", "This page is denied by a grant and must never be indexed."));
        return;
      }
      res.writeHead(200, { "content-type": "text/html" }).end(page("Root", "Index page."));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(async () => { await new Promise<void>((r) => server.close(() => r())); });

  beforeEach(async () => {
    await ctx.daemon?.stop();
    await ctx.schema?.close();
    if (ctx.tmp) rmSync(ctx.tmp, { recursive: true, force: true });
    ctx.tmp = mkdtempSync(join(tmpdir(), "prag-crawl-"));
    ctx.schema = new LanceDbSchema({
      dbPath: join(ctx.tmp, "db"), embeddingDim: 4, maxVectorUnitTokens: 512, modelMaxSeqLength: 512,
    });
    await ctx.schema.init();
    ctx.daemon = new Daemon({
      port: 0, token: "t", noExit: true,
      webBackend: makeCrawlbergBackend({ allowPrivateNetwork: true, rateLimitMs: 0 }),
      webCooldownSeconds: 3600,
    });
    await ctx.daemon.start(ctx.schema, new FakeEmbeddingProvider(4));
    await upsertGrants(ctx.schema.table("grants"), [
      { pattern: `${origin}/**`, action: "allow", reason: "watch_root", createdAt: new Date() },
      { pattern: `${origin}/private`, action: "deny", reason: "user_deny", createdAt: new Date() },
    ]);
    ctx.daemon.invalidateGrantCache();
  });

  after(async () => {
    await ctx.daemon?.stop();
    await ctx.schema?.close();
    if (ctx.tmp) rmSync(ctx.tmp, { recursive: true, force: true });
  });

  const indexedUris = async () =>
    ((await ctx.schema!.table("file_mapping").query().limit(50).toArray()) as Array<{ uri: string }>)
      .map((r) => r.uri).sort();

  void it("indexes every page the grants admit", async () => {
    const out = await ctx.daemon!.ingestWebSite(origin);
    assert.equal(out.discovered, 4);
    assert.equal(out.indexed, 2, JSON.stringify(out));
    assert.deepEqual(await indexedUris(), [`${origin}/guide`, `${origin}/reference`]);
  });

  void it("re-applies the grants to URLs the backend returned", async () => {
    // The deny is on a child of the allowed prefix. A crawl that only checked
    // the grant at registration would index it, which is the hole ADR-009's
    // longest-prefix match exists to close.
    const out = await ctx.daemon!.ingestWebSite(origin);
    assert.equal(out.skipped, 1, "the denied page was not skipped");
    const uris = await indexedUris();
    assert.ok(!uris.includes(`${origin}/private`), "a denied page reached the index");
  });

  void it("counts a failing page instead of abandoning the crawl", async () => {
    const out = await ctx.daemon!.ingestWebSite(origin);
    assert.equal(out.failed, 1, "the 500 was not counted as a failure");
    // ...and the pages after it in the list still got indexed.
    assert.equal(out.indexed, 2);
  });

  void it("honours the page bound", async () => {
    const out = await ctx.daemon!.ingestWebSite(origin, { maxPages: 1 });
    assert.equal(out.discovered, 1);
    assert.equal(out.indexed, 1);
  });

  void it("makes the crawled pages searchable under the site's project", async () => {
    await ctx.daemon!.ingestWebSite(origin);
    const projectId = Daemon.webProjectId(`${origin}/guide`);
    const projects = (await ctx.schema!.table("projects").query().limit(10).toArray()) as
      Array<{ projectId: string; isGit: boolean }>;
    assert.equal(projects.length, 1, "the site was not registered as one project");
    assert.equal(projects[0].projectId, projectId);
    assert.equal(projects[0].isGit, false);
  });

  void it("watching a bare origin crawls it rather than refusing", async () => {
    // This path used to throw CRAWL_CAPABILITY_UNAVAILABLE unconditionally:
    // the grant was written and nothing was indexed.
    const out = await ctx.daemon!.watchUri({ uri: origin });
    assert.equal(out.status, "active");
    // watchUri returns the untyped HTTP body shape, shared with the local
    // scan path, so the crawl counters are read the same way a client reads
    // them.
    const discovered = out.discovered as { files: number; skipped: Record<string, number> };
    assert.equal(discovered.files, 2, JSON.stringify(discovered));
    assert.deepEqual(discovered.skipped, { denied: 1, errored: 1 });
  });
}
void describe("web crawl ingestion", webCrawlSuite);
