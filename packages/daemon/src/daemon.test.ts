import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  LanceDbSchema,
  FakeEmbeddingProvider,
} from "@prag/core";
import { Daemon } from "./daemon.js";

void describe("Daemon", () => {
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
    assert.equal(res.status, 403);
  });

  void it("rejects unknown paths", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/unknown`, {
      headers: { Authorization: "Bearer test-token" },
    });
    assert.equal(res.status, 404);
  });
});
