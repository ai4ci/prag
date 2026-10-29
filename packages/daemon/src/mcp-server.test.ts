import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { LanceDbSchema, FakeEmbeddingProvider } from "@prag/core";
import { Daemon } from "./daemon.js";

void describe("MCP server", () => {
  let tmpDir: string;
  let schema: LanceDbSchema;
  let daemon: Daemon;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "prag-mcp-"));
    schema = new LanceDbSchema({
      dbPath: tmpDir,
      embeddingDim: 4,
      maxVectorUnitTokens: 512,
      modelMaxSeqLength: 512,
    });
    await schema.init();

    daemon = new Daemon({ port: 0, token: "test-token", noExit: true });
    await daemon.start(schema, new FakeEmbeddingProvider(4));
  });

  after(async () => {
    await daemon.stop();
    await schema.close();
    rmSync(tmpDir, { recursive: true, force: true });
    await new Promise((r) => setImmediate(r));
  });

  void it("GET /mcp establishes SSE stream", async () => {
    const port = daemon.boundPort!;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1000);
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      headers: { Authorization: "Bearer test-token" },
      signal: ac.signal,
    });
    clearTimeout(t);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const reader = res.body?.getReader();
    if (reader) {
      const ac2 = new AbortController();
      setTimeout(() => ac2.abort(), 500);
      let body = "";
      try {
        for (;;) {
          const { done, value } = await reader.read({ signal: ac2.signal });
          if (done) break;
          body += new TextDecoder().decode(value);
          if (body.includes("sessionId=")) break;
        }
      } catch { /* stream aborted, fine */ }
      assert.ok(body.includes("event: endpoint"));
      assert.ok(body.includes("/mcp?sessionId="));
      await reader.cancel().catch(() => {});
    }
  });

  void it("POST /mcp without sessionId returns 400", async () => {
    const port = daemon.boundPort!;
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(res.status, 400);
    const text = await res.text();
    assert.ok(text.includes("sessionId"));
  });

  void it("POST /mcp with unknown sessionId returns 404", async () => {
    const port = daemon.boundPort!;
    const res = await fetch(`http://127.0.0.1:${port}/mcp?sessionId=nonexistent`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(res.status, 404);
  });
});
