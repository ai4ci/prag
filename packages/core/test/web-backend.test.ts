// @prag/core — ADR-024 backend selection and capability negotiation.
//
// No test here performs a network call: the built-in fetcher is exercised
// against a loopback server, and everything else against a stub. Running the
// suite with the network disabled must be indistinguishable from a normal run.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

import {
  registerWebBackend,
  resolveWebBackend,
  availableWebBackends,
  requireCapability,
  htmlToText,
  PLAIN_FETCHER_ID,
  DaemonFailure,
  type WebFetchBackend,
  type WebCapability,
} from "../src/index.js";

/** A backend with exactly the capabilities a test asks for, and no egress. */
function stub(id: string, caps: WebCapability[]): WebFetchBackend {
  return {
    id,
    endpoint: `stub://${id}`,
    capabilities: new Set(caps),
    async fetch(url) {
      return { url, text: `stub body for ${url}`, freshness: { kind: "cached", ageSeconds: 42 } };
    },
    async discover(prefix) {
      return { urls: [`${prefix}/one`, `${prefix}/two`], freshness: { kind: "live" } };
    },
  };
}

function webBackendSuite(): void {
  void it("registers the zero-configuration built-in", () => {
    assert.ok(availableWebBackends().includes(PLAIN_FETCHER_ID));
    const b = resolveWebBackend(PLAIN_FETCHER_ID, {})!;
    assert.equal(b.id, PLAIN_FETCHER_ID);
    // fetch only: watching a prefix must be refused, not silently narrowed.
    assert.deepEqual([...b.capabilities], ["fetch"]);
  });

  void it("no backend configured means local-only, not an error", () => {
    assert.equal(resolveWebBackend(undefined, {}), null);
    assert.equal(resolveWebBackend("", {}), null);
  });

  void it("an unknown id fails loudly and names the alternatives", () => {
    // ADR-024: never a silent fallback. A user who typed `firecrwal` must not
    // quietly get a different egress path from the one they asked for.
    assert.throws(
      () => resolveWebBackend("firecrwal", {}),
      (err: unknown) => {
        assert.ok(err instanceof DaemonFailure);
        assert.equal(err.code, "INVALID_REQUEST");
        assert.match(err.remedy ?? "", /plain-fetcher/);
        return true;
      },
    );
  });

  void it("refuses a missing capability by code, naming who provides it", () => {
    registerWebBackend("test-crawler", () => stub("test-crawler", ["fetch", "discover"]));
    const fetchOnly = stub("fetch-only", ["fetch"]);

    assert.throws(
      () => requireCapability(fetchOnly, "discover", "https://example.test/docs"),
      (err: unknown) => {
        assert.ok(err instanceof DaemonFailure);
        // Asserted by code, never message text (ADR-022).
        assert.equal(err.code, "CRAWL_CAPABILITY_UNAVAILABLE");
        const d = err.details as { providers: string[]; required: string };
        assert.equal(d.required, "discover");
        assert.ok(d.providers.includes("test-crawler"),
          `the refusal did not name a backend that can discover: ${JSON.stringify(d.providers)}`);
        return true;
      },
    );

    // ...and allows what the backend does have.
    assert.equal(requireCapability(fetchOnly, "fetch", "https://example.test/p").id, "fetch-only");
  });

  void it("no backend at all is CRAWL_BACKEND_REQUIRED, not a capability error", () => {
    assert.throws(
      () => requireCapability(null, "fetch", "https://example.test/p"),
      (err: unknown) => {
        assert.ok(err instanceof DaemonFailure);
        assert.equal(err.code, "CRAWL_BACKEND_REQUIRED");
        return true;
      },
    );
  });

  void it("strips markup and script bodies out of html", () => {
    const text = htmlToText(
      "<html><head><title>T</title><style>.a{color:red}</style></head>" +
      "<body><script>alert('x')</script><p>Hello</p><p>World &amp; more</p></body></html>",
    );
    assert.ok(!text.includes("alert"), `script body survived: ${text}`);
    assert.ok(!text.includes("color:red"), `style body survived: ${text}`);
    assert.match(text, /Hello/);
    assert.match(text, /World & more/);
  });
}

function plainFetcherSuite(): void {
  let server: Server;
  let base = "";

  before(async () => {
    server = createServer((req, res) => {
      if (req.url === "/big") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("x".repeat(50_000));
        return;
      }
      if (req.url === "/missing") {
        res.writeHead(404).end("nope");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><head><title>Doc</title></head><body><p>body text here</p></body></html>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(async () => { await new Promise<void>((r) => server.close(() => r())); });

  void it("fetches and extracts text, reporting live freshness", async () => {
    const b = resolveWebBackend(PLAIN_FETCHER_ID, {})!;
    const got = await b.fetch!(`${base}/page`);
    assert.match(got.text, /body text here/);
    assert.equal(got.title, "Doc");
    // It has no cache of its own, so claiming anything else would be a lie
    // that ADR-008's freshness leases would then act on.
    assert.equal(got.freshness.kind, "live");
  });

  void it("caps the payload at maxBytes instead of buffering it all", async () => {
    const b = resolveWebBackend(PLAIN_FETCHER_ID, {})!;
    const got = await b.fetch!(`${base}/big`, { maxBytes: 1000 });
    assert.ok(got.text.length <= 1000, `read ${got.text.length} bytes past the cap`);
  });

  void it("surfaces an HTTP error rather than indexing the error page", async () => {
    const b = resolveWebBackend(PLAIN_FETCHER_ID, {})!;
    await assert.rejects(() => b.fetch!(`${base}/missing`), /404/);
  });
}

void describe("web fetch backends (ADR-024)", webBackendSuite);
void describe("plain-fetcher", plainFetcherSuite);
