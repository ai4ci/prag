// @prag/daemon — ADR-022 error envelope contract
//
// ADR-022 §1 makes `code` the contract: tests and MCP clients branch on it and
// must never match on message text. These tests deliberately contain no
// message assertions — if a message is reworded, this file must stay unchanged.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  LanceDbSchema,
  FakeEmbeddingProvider,
  DaemonFailure,
  EXIT_FOR_CODE,
  HTTP_STATUS_FOR_CODE,
  type ErrorCode,
} from "@prag/core";
import { Daemon } from "../src/daemon.js";

const TOKEN = "test-envelope";
const HEADERS = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${TOKEN}`,
};

const ENVELOPE_KEYS = ["code", "message", "remedy", "details"];

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Asserts the ADR-022 §1 shape, the ADR-022 §2 status, and that the code belongs
 * to the closed set the exit mapping is total over. Returns the error object.
 */
function envelopeOf(
  res: { status: number; text: string; body: any },
  code: ErrorCode,
): any {
  assert.ok(res.status >= 400, `expected an error status, got ${res.status}`);
  assert.ok(res.body, `error response is not JSON: ${res.text.slice(0, 160)}`);
  assert.deepEqual(Object.keys(res.body), ["error"]);
  const err = res.body.error;
  for (const key of Object.keys(err)) {
    assert.ok(ENVELOPE_KEYS.includes(key), `unexpected envelope field '${key}'`);
  }
  assert.equal(err.code, code);
  assert.equal(typeof err.message, "string");
  assert.ok(err.message.length > 0, "message must be present for a human reader");
  assert.ok(
    code in EXIT_FOR_CODE,
    `'${code}' is not in the ADR-022 code set, so it has no exit code`,
  );
  // The status answered with must be the one the shared table implies, so a
  // handler cannot drift from the mapping (ADR-022 §2).
  assert.equal(res.status, HTTP_STATUS_FOR_CODE[code], `${code} answered with ${res.status}`);
  return err;
}

function errorEnvelopeSuite(): void {
  const ctx: {
    tmpDir: string;
    schema: LanceDbSchema | null;
    daemon: Daemon | null;
    port: number;
  } = { tmpDir: "", schema: null, daemon: null, port: 0 };

  before(async () => {
    ctx.tmpDir = mkdtempSync(join(tmpdir(), "prag-envelope-"));
    ctx.schema = new LanceDbSchema({
      dbPath: ctx.tmpDir,
      embeddingDim: 4,
      maxVectorUnitTokens: 512,
      modelMaxSeqLength: 512,
    });
    await ctx.schema.init();
    ctx.daemon = new Daemon({
      port: 0,
      token: TOKEN,
      noExit: true,
      // Threshold set so a watch of this tree is refused: the refusal path is the
      // contract under test, and 0 files means any non-empty tree trips it.
      ingestion: { poolSize: 1, cooldownMs: 20, watchConfirmThreshold: { projects: 1, files: 0 } },
    });
    await ctx.daemon.start(ctx.schema, new FakeEmbeddingProvider(4));
    ctx.port = ctx.daemon.boundPort!;
  });

  after(async () => {
    await ctx.daemon?.stop();
    await ctx.schema?.close();
    if (ctx.tmpDir) rmSync(ctx.tmpDir, { recursive: true, force: true });
    await new Promise((r) => setImmediate(r));
  });

  async function call(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = HEADERS,
  ) {
    const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, text, body: safeJson(text) };
  }

  const envelope = (res: { status: number; text: string; body: any }, code: ErrorCode) =>
    envelopeOf(res, code);

  // /health is deliberately token-free (a readiness probe must work), so the
  // auth cases use an endpoint that is protected.
  void it("rejects a bad token as UNAUTHORIZED, not as text", async () => {
    const res = await call("GET", "/grants", undefined, { Authorization: "Bearer wrong" });
    envelope(res, "UNAUTHORIZED");
  });

  void it("rejects a remote Origin as ORIGIN_REJECTED", async () => {
    const res = await call("GET", "/grants", undefined, {
      ...HEADERS,
      Origin: "http://evil.test",
    });
    envelope(res, "ORIGIN_REJECTED");
  });

  void it("answers an unknown route with a NOT_FOUND envelope naming the route", async () => {
    const res = await call("POST", "/no-such-endpoint");
    const err = envelope(res, "NOT_FOUND");
    // Checking the route is echoed is not a message match: the route is ours.
    assert.match(err.message, /\/no-such-endpoint/);
  });

  void it("answers the wrong method with METHOD_NOT_ALLOWED", async () => {
    const res = await call("DELETE", "/search");
    envelope(res, "METHOD_NOT_ALLOWED");
  });

  void it("rejects a malformed body with INVALID_REQUEST and a remedy", async () => {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/search`, {
      method: "POST",
      headers: HEADERS,
      body: "{not json",
    });
    const text = await res.text();
    const err = envelope({ status: res.status, text, body: safeJson(text) }, "INVALID_REQUEST");
    assert.equal(typeof err.remedy, "string", "a rejectable request needs a remedy");
  });

  void it("refuses an empty query with INVALID_REQUEST", async () => {
    const res = await call("POST", "/search", { query: "" });
    envelope(res, "INVALID_REQUEST");
  });

  void it("reports a missing project directory as INVALID_REQUEST", async () => {
    const res = await call("POST", "/projects", {
      name: "gone",
      rootUri: "file:///no/such/dir/at/all",
    });
    envelope(res, "INVALID_REQUEST");
  });

  void it("refuses to search a project that is not registered (ADR-018)", async () => {
    const res = await call("POST", "/search", { query: "anything", projectId: "no-such-proj" });
    envelope(res, "PROJECT_NOT_FOUND");
  });

  void it("names the threshold and counts when a watch is refused (ADR-023)", async () => {
    writeFileSync(join(ctx.tmpDir, "a.ts"), "export const a = 1;\n");
    const res = await call("POST", "/projects/watch", { uri: `file://${ctx.tmpDir}` });
    const err = envelope(res, "WATCH_LIMIT_EXCEEDED");
    assert.equal(typeof err.remedy, "string");
    assert.ok(err.details, "a refused watch must report what it counted");
    for (const key of ["projects", "files", "threshold"]) {
      assert.ok(key in err.details, `details.${key} missing`);
    }
  });

  void it("answers a refused non-local watch with a CRAWL_BACKEND_REQUIRED envelope", async () => {
    const res = await call("POST", "/projects/watch", { uri: "https://example.test/docs" });
    envelope(res, "CRAWL_BACKEND_REQUIRED");
  });

  void it("serves only health/reembed/shutdown while the index is mismatched (ADR-015)", async () => {
    // Same shape bootstrap produces when the sidecar pins another model: a
    // degraded daemon that answers those three and refuses everything else 409.
    const mismatch = new DaemonFailure(
      "EMBEDDING_MODEL_MISMATCH",
      "configured model differs from the pinned one",
      "Run `prag reembed`.",
    );
    const degraded = new Daemon({ port: 0, token: TOKEN, noExit: true });
    await degraded.start(null, null, { mismatch });
    const port = degraded.boundPort!;
    try {
      const refused = await fetch(`http://127.0.0.1:${port}/search`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ query: "x" }),
      });
      const text = await refused.text();
      const err = envelopeOf({ status: refused.status, text, body: safeJson(text) },
        "EMBEDDING_MODEL_MISMATCH");
      assert.equal(typeof err.remedy, "string");

      const served = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(served.status, 200);
      const health = (await served.json()) as {
        status: string;
        mismatch?: { served: string[] };
      };
      assert.equal(health.status, "mismatch");
      // The refusal names what is still served, so a client need not guess.
      assert.deepEqual(health.mismatch?.served, ["/health", "/reembed", "/shutdown"]);
    } finally {
      await degraded.stop();
    }
  });

  void it("does not report the open index as unavailable", async () => {
    // Guards the 503 branch against a dropped handle: /prune reaching 503 here
    // would mean a live index was reported SERVICE_UNAVAILABLE.
    const res = await call("POST", "/prune", {});
    assert.notEqual(res.status, 503, res.text);
  });
}

describe("error envelope", errorEnvelopeSuite);
