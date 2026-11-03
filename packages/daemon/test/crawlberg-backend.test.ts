// @prag/daemon — ADR-024: the crawlberg backend, exercised for real.
//
// The backend is not stubbed here. A loopback HTTP server stands in for the
// origin and the actual crawler fetches from it, so what is under test is
// crawlberg's HTML->Markdown conversion and sitemap discovery rather than a
// mock's idea of them. Nothing in this file reaches the network: the suite is
// one of the reasons `local-first-egress.test.ts` watches the socket layer
// rather than trusting that no test makes a request.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

import { makeCrawlbergBackend } from "../src/crawlberg-backend.js";
import { resolveWebBackend } from "@prag/core";

const PAGE = `<!doctype html>
<html><head><title>Vector pool</title>
<meta name="description" content="how dedup works"></head>
<body>
  <nav><a href="/elsewhere">Navigation that is not content</a></nav>
  <h1>Vector pool</h1>
  <p>The pool deduplicates content by <strong>chunk hash</strong>.</p>
  <h2>Unit windows</h2>
  <ul><li>one unit per window</li><li>overlap is configurable</li></ul>
  <table><tr><th>column</th><th>type</th></tr><tr><td>chunkHash</td><td>text</td></tr></table>
  <script>console.error("script content must not be indexed")</script>
</body></html>`;

function crawlbergSuite(): void {
  let server: Server;
  let origin = "";

  before(async () => {
    server = createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\nDisallow: /private\n");
        return;
      }
      if (path === "/sitemap.xml") {
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(`<?xml version="1.0" encoding="UTF-8"?>
          <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
            <url><loc>${origin}/guide</loc></url>
            <url><loc>${origin}/reference</loc></url>
          </urlset>`);
        return;
      }
      if (path === "/guide") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(PAGE);
        return;
      }
      if (path === "/missing") {
        res.writeHead(404, { "content-type": "text/html" });
        res.end("<html><body>gone</body></html>");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><head><title>Root</title></head><body><h1>Root</h1></body></html>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    origin = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  after(() => { server.close(); });

  // `allowPrivateNetwork` is the whole reason this is explicit in the options:
  // every other caller gets loopback refused, and the suite has to opt in.
  const backend = () => makeCrawlbergBackend({ allowPrivateNetwork: true, rateLimitMs: 0 });

  void it("declares fetch and discover", () => {
    const b = backend();
    assert.equal(b.id, "crawlberg");
    assert.deepEqual([...b.capabilities].sort(), ["discover", "fetch"]);
  });

  void it("is resolvable by id, so web.backend: crawlberg is a working config", () => {
    // The registration happens as an import side effect; importing the module
    // for `makeCrawlbergBackend` above is what puts it in the registry. If the
    // side effect is ever dropped this fails rather than silently leaving the
    // documented config value unresolvable.
    const b = resolveWebBackend("crawlberg", {});
    assert.equal(b?.id, "crawlberg");
  });

  void it("converts a page to Markdown, not to a wall of prose", async () => {
    const r = await backend().fetch(`${origin}/guide`);

    // The point of replacing plain-fetcher: structure survives, so the
    // heading chunker has boundaries to split on.
    assert.match(r.text, /^# Vector pool$/m, "h1 did not become a Markdown heading");
    assert.match(r.text, /^## Unit windows$/m, "h2 did not become a Markdown heading");
    assert.match(r.text, /^- one unit per window$/m, "list items were flattened");
    assert.match(r.text, /\|\s*chunkHash\s*\|/, "the table did not survive as a table");
    assert.match(r.text, /\*\*chunk hash\*\*/, "inline emphasis was dropped");

    assert.equal(r.title, "Vector pool");
    assert.match(r.contentType ?? "", /text\/html/);
    assert.equal(r.freshness.kind, "live", "crawlberg holds no cache, so nothing is 'cached'");
  });

  void it("strips page chrome that would otherwise be embedded as content", async () => {
    const r = await backend().fetch(`${origin}/guide`);
    assert.doesNotMatch(r.text, /script content must not be indexed/,
      "a <script> body reached the index");
    assert.doesNotMatch(r.text, /Navigation that is not content/,
      "nav chrome reached the index");
  });

  void it("does not prepend frontmatter, which the chunker would read as content", async () => {
    const r = await backend().fetch(`${origin}/guide`);
    assert.doesNotMatch(r.text.slice(0, 40), /^---/,
      "metadata frontmatter leaked into the indexed text");
  });

  void it("caps the returned text at maxBytes", async () => {
    const r = await backend().fetch(`${origin}/guide`, { maxBytes: 40 });
    assert.ok(r.text.length <= 40, `got ${r.text.length} characters for a 40-byte budget`);
  });

  void it("raises an HTTP error rather than indexing the error page", async () => {
    // softHttpErrors is deliberately off: a 404 body is not content, and
    // indexing it would put "gone" in the index under the requested URL.
    await assert.rejects(() => backend().fetch(`${origin}/missing`));
  });

  void it("discovers a site's URLs from its sitemap", async () => {
    const r = await backend().discover(origin);
    assert.deepEqual(r.urls.sort(), [`${origin}/guide`, `${origin}/reference`]);
    assert.equal(r.freshness.kind, "live");
  });

  void it("honours the discover limit", async () => {
    const r = await backend().discover(origin, { limit: 1 });
    assert.equal(r.urls.length, 1);
  });

  void it("refuses a private address unless the caller opts in", async () => {
    // The default must deny loopback and RFC1918. A grant for a public URL is
    // not consent to reach the user's own network, and crawlberg's
    // CRAWLBERG_ALLOW_PRIVATE_NETWORK override is pinned off so an unrelated
    // environment variable cannot widen this.
    const strict = makeCrawlbergBackend();
    await assert.rejects(() => strict.fetch(`${origin}/guide`),
      "the default configuration reached a loopback address");
  });

  void it("pins the private-network denial against the environment override", async () => {
    const before = process.env.CRAWLBERG_ALLOW_PRIVATE_NETWORK;
    process.env.CRAWLBERG_ALLOW_PRIVATE_NETWORK = "1";
    try {
      const strict = makeCrawlbergBackend();
      await assert.rejects(() => strict.fetch(`${origin}/guide`),
        "an environment variable prag does not document widened its egress");
    } finally {
      if (before === undefined) delete process.env.CRAWLBERG_ALLOW_PRIVATE_NETWORK;
      else process.env.CRAWLBERG_ALLOW_PRIVATE_NETWORK = before;
    }
  });
}
void describe("crawlberg backend", crawlbergSuite);
