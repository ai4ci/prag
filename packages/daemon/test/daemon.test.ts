import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  LanceDbSchema,
  FakeEmbeddingProvider,
} from "@prag/core";
import { Daemon } from "../src/daemon.js";

function daemonSuite(): void {
  let tmpDir: string;
  let schema: LanceDbSchema;
  let daemon: Daemon;
  const PORT = 19876;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "prag-daemon-"));
    schema = new LanceDbSchema({
      dbPath: tmpDir,
      embeddingDim: 4,
      maxVectorUnitTokens: 512,
      modelMaxSeqLength: 512,
    });
    await schema.init();

    daemon = new Daemon({ port: PORT, token: "test-token" });
    await daemon.start(schema, new FakeEmbeddingProvider(4));
  });

  after(async () => {
    await daemon.stop();
    await schema.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  void it("starts and listens on the configured port", () => {
    assert.ok(daemon.listening);
  });

  void it("GET /health returns OK with correct shape", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`);
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.service, "prag-daemon");
    assert.equal(body.apiVersion, 1);
    assert.equal(body.pid, process.pid);
    assert.equal(typeof body.uptime, "number");
    assert.equal(typeof body.port, "number");
    // Path isolation fields (ADR-019)
    assert.equal(body.root, null);
    assert.equal(typeof body.dataDir, "string");
    assert.equal(typeof body.configDir, "string");
    assert.equal(typeof body.runDir, "string");
  });

  void it("GET /health works without auth", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`);
    assert.equal(res.status, 200);
  });

  void it("rejects requests without auth on protected endpoints", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "hello", limit: 5 }),
    });
    assert.equal(res.status, 401);
  });

  void it("POST /search returns results with valid auth", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({ query: "hello", limit: 5 }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.query, "hello");
    assert.ok(Array.isArray(body.hits));
    assert.equal(typeof body.totalChunks, "number");
  });

  void it("GET /projects returns list", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/projects`, {
      headers: { Authorization: "Bearer test-token" },
    });
    assert.equal(res.status, 200);
    const projects = await res.json() as Array<unknown>;
    assert.ok(Array.isArray(projects));
  });

  void it("rejects non-localhost origin", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`, {
      headers: { Origin: "https://evil.com" },
    });
    // 401: ADR-022 §2 groups a rejected Origin with an authentication failure.
    assert.equal(res.status, 401);
  });

  void it("rejects unknown paths", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/unknown`, {
      headers: { Authorization: "Bearer test-token" },
    });
    assert.equal(res.status, 404);
  });

  void it("a port already in use rejects with EADDRINUSE instead of an unhandled throw", async () => {
    // Two things were wrong before: the 'error' event had no listener, so it
    // escaped as an unhandled exception (which in a test run is an unstable exit,
    // and in the daemon killed the process with a bare stack trace), and start()
    // resolved anyway because nothing rejected the listen promise.
    const clashing = new Daemon({ port: PORT, token: "other" });
    await assert.rejects(
      () => clashing.start(schema, new FakeEmbeddingProvider(4)),
      (err: NodeJS.ErrnoException) => {
        assert.equal(err.code, "EADDRINUSE");
        return true;
      },
    );
    assert.ok(!clashing.listening, "a daemon that failed to bind must not report listening");
  });

  void it("a stalled connection does not hold shutdown open", async () => {
    // headersTimeout/requestTimeout exist so a client that opens a socket and sends
    // nothing cannot keep the server pending forever; the user-visible form of that
    // is `prag daemon stop` returning while such a connection is open.
    const spare = new Daemon({ port: PORT + 1, token: "spare" });
    await spare.start(schema, new FakeEmbeddingProvider(4));
    const net = await import("node:net");

    // A socket that connects and says nothing at all.
    const stalled = net.connect(PORT + 1, "127.0.0.1");
    stalled.on("error", () => {});
    await new Promise<void>((resolve, reject) => {
      stalled.once("connect", () => resolve());
      stalled.once("error", reject);
    });

    const started = Date.now();
    await spare.stop();
    const elapsed = Date.now() - started;
    stalled.destroy();
    assert.ok(
      elapsed < 5_000,
      `stop() took ${elapsed}ms with one idle connection open; closeAllConnections() ` +
        "must run before close() or shutdown waits for the client to hang up",
    );
  });

  void it("bounds request and keep-alive timeouts", () => {
    // Asserted as configuration because the platform's own timer granularity makes
    // a behavioural test of headersTimeout a 10-second test.
    const srv = (daemon as unknown as {
      server?: { headersTimeout?: number; requestTimeout?: number; keepAliveTimeout?: number };
    }).server;
    assert.equal(srv?.headersTimeout, 10_000);
    assert.equal(srv?.requestTimeout, 60_000);
    assert.equal(srv?.keepAliveTimeout, 5_000);
  });
}
void describe("Daemon", daemonSuite);
