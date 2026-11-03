// @prag/daemon — ADR-012/ADR-024: indexing and searching local content makes
// no outbound network connection.
//
// This is the guarantee the project is named for, and nothing asserted it. The
// check is deliberately at the socket layer rather than at `fetch`: a model
// download or a JS-level telemetry call would bypass `fetch` entirely, and
// those are exactly the paths worth catching.
//
// KNOWN LIMIT, measured rather than assumed: the socket hook sees only
// connections made through Node's `net` module. A native addon with its own
// HTTP stack is invisible to it. `@xberg-io/crawlberg` is exactly that -- a
// loopback scrape through it records **0** `net.Socket.connect` calls where
// Node's own `fetch` to the same URL records 1. So a green run of the first
// test below is not evidence that the crawler stayed silent.
//
// The second line of defence is therefore behavioural, not observational:
// `the local path never calls the web backend` asserts that indexing and
// searching file:// content does not invoke the backend at all. That is the
// property actually at stake, and unlike the socket count it is observable
// from JavaScript. Proving a native addon's silence needs an OS-level tool
// (a network namespace, seccomp, or strace) and is a deployment-time check,
// not a unit test.
//
// "Local" means file:// grants only. The assertion is NOT weakened to
// "localhost only" — loopback is allowed because the daemon is a loopback
// service, but anything leaving the machine fails the test.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import net from "node:net";
import dns from "node:dns";

import {
  LanceDbSchema, FakeEmbeddingProvider,
  type WebFetchBackend, type WebCapability,
} from "@prag/core";
import { Daemon } from "../src/daemon.js";

const TOKEN = "test-egress";
const HEADERS = { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost" || host === "";
}

/**
 * Record every non-loopback socket connection and DNS lookup for the duration.
 * Returns a stop function yielding what was seen.
 */
function watchEgress(): () => string[] {
  const seen: string[] = [];
  const realConnect = net.Socket.prototype.connect;
  const realLookup = dns.lookup;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (net.Socket.prototype as any).connect = function (...args: any[]) {
    // `net.connect(opts)` reaches here as ONE argument that is the array
    // `[options, cb]` produced by Node's normalizeArgs, not as the options
    // object. Reading args[0].host directly saw undefined and recorded
    // nothing, which is why this hook needs its own test.
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const host =
      typeof first === "object" && first !== null
        ? String(first.host ?? first.path ?? "")
        : typeof first === "number" && typeof args[1] === "string" ? args[1] : "";
    if (host && !isLoopback(host)) seen.push(`connect ${host}`);
    return realConnect.apply(this, args as never);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (dns as any).lookup = function (hostname: string, ...rest: any[]) {
    if (!isLoopback(hostname)) seen.push(`dns ${hostname}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (realLookup as any)(hostname, ...rest);
  };

  return () => {
    net.Socket.prototype.connect = realConnect;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dns as any).lookup = realLookup;
    return seen;
  };
}

function egressSuite(): void {
  const ctx: { tmpDir: string; schema: LanceDbSchema | null; daemon: Daemon | null; port: number } =
    { tmpDir: "", schema: null, daemon: null, port: 0 };
  let corpus = "";

  before(async () => {
    ctx.tmpDir = mkdtempSync(join(tmpdir(), "prag-egress-"));
    ctx.schema = new LanceDbSchema({
      dbPath: join(ctx.tmpDir, "lancedb"),
      embeddingDim: 4, maxVectorUnitTokens: 512, modelMaxSeqLength: 512,
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
    writeFileSync(join(corpus, "a.ts"), "export function alpha() { return 'vector pool'; }\n");
    writeFileSync(join(corpus, "b.md"), "# Notes\n\nSome prose about ranking and fusion.\n");
  });

  after(async () => {
    await ctx.daemon?.stop();
    await ctx.schema?.close();
    rmSync(ctx.tmpDir, { recursive: true, force: true });
  });

  void it("index + search over file:// content makes zero outbound connections", async () => {
    const stop = watchEgress();
    let seen: string[];
    try {
      const watch = await fetch(`http://127.0.0.1:${ctx.port}/projects/watch`, {
        method: "POST", headers: HEADERS,
        body: JSON.stringify({ uri: `file://${corpus}`, projectId: "local", confirm: true }),
      });
      assert.equal(watch.status, 200, await watch.text());

      const sync = await fetch(`http://127.0.0.1:${ctx.port}/sync`, {
        method: "POST", headers: HEADERS, body: JSON.stringify({ projectId: "local" }),
      });
      assert.equal(sync.status, 200, await sync.text());

      const search = await fetch(`http://127.0.0.1:${ctx.port}/search`, {
        method: "POST", headers: HEADERS,
        body: JSON.stringify({ query: "vector pool ranking", limit: 5, projectId: "local" }),
      });
      assert.equal(search.status, 200);
      const hits = ((await search.json()) as { hits: unknown[] }).hits;
      assert.ok(hits.length > 0, "the cycle indexed nothing, so egress proves nothing");
    } finally {
      seen = stop();
    }

    assert.deepEqual(seen, [],
      `a local index+search cycle reached the network: ${JSON.stringify(seen)}`);
  });

  void it("the local path never calls the web backend", async () => {
    // The socket watcher cannot see a native addon's own HTTP stack (see the
    // header), so the guarantee is asserted where it is observable: with a
    // backend configured, a full local index-and-search cycle must not reach
    // for it even once. A counting stand-in catches any call; what it cannot
    // catch is a backend that phones home when it is *constructed*, which is
    // why `crawlberg-backend.test.ts` pins the SSRF policy separately.
    const calls: string[] = [];
    const counting: WebFetchBackend = {
      id: "counting",
      endpoint: "(test)",
      capabilities: new Set<WebCapability>(["fetch", "discover"]),
      async fetch(url) {
        calls.push(`fetch ${url}`);
        return { url, text: "", freshness: { kind: "live" } };
      },
      async discover(prefix) {
        calls.push(`discover ${prefix}`);
        return { urls: [], freshness: { kind: "live" } };
      },
    };

    const tmp = mkdtempSync(join(tmpdir(), "prag-egress-backend-"));
    const schema = new LanceDbSchema({
      dbPath: join(tmp, "lancedb"),
      embeddingDim: 4, maxVectorUnitTokens: 512, modelMaxSeqLength: 512,
    });
    await schema.init();
    const daemon = new Daemon({
      port: 0, token: TOKEN, noExit: true,
      webBackend: counting,
      ingestion: { poolSize: 1, cooldownMs: 5 },
    });
    await daemon.start(schema, new FakeEmbeddingProvider(4));
    const port = daemon.boundPort!;
    try {
      const watch = await fetch(`http://127.0.0.1:${port}/projects/watch`, {
        method: "POST", headers: HEADERS,
        body: JSON.stringify({ uri: `file://${corpus}`, projectId: "local", confirm: true }),
      });
      assert.equal(watch.status, 200, await watch.text());
      const sync = await fetch(`http://127.0.0.1:${port}/sync`, {
        method: "POST", headers: HEADERS, body: JSON.stringify({ projectId: "local" }),
      });
      assert.equal(sync.status, 200, await sync.text());
      const search = await fetch(`http://127.0.0.1:${port}/search`, {
        method: "POST", headers: HEADERS,
        body: JSON.stringify({ query: "vector pool ranking", limit: 5, projectId: "local" }),
      });
      assert.equal(search.status, 200);
      const hits = ((await search.json()) as { hits: unknown[] }).hits;
      assert.ok(hits.length > 0, "the cycle indexed nothing, so the assertion proves nothing");
    } finally {
      await daemon.stop();
      await schema.close();
      rmSync(tmp, { recursive: true, force: true });
    }

    assert.deepEqual(calls, [],
      `configuring a web backend changed what a purely local cycle does: ${JSON.stringify(calls)}`);
  });

  void it("the egress watcher actually detects a connection", async () => {
    // Without this, the assertion above passes just as well when the hook is
    // broken. A listener on loopback is not enough — it must catch a host that
    // is not loopback, so the probe uses a TEST-NET-1 address (RFC 5737) and
    // does not care whether the connection succeeds.
    const stop = watchEgress();
    await new Promise<void>((done) => {
      const s = net.connect({ host: "192.0.2.1", port: 9 });
      const finish = () => { s.destroy(); done(); };
      s.on("error", finish);
      s.on("connect", finish);
      setTimeout(finish, 250);
    });
    const seen = stop();
    assert.ok(seen.some((e) => e.includes("192.0.2.1")),
      `the egress watcher missed a real outbound connection: ${JSON.stringify(seen)}`);
  });
}

void describe("local-first egress", egressSuite);
