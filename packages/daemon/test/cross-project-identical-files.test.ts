// @prag/daemon — byte-identical files in two projects must stay two files.
//
// `chunks_pool` dedups on content hash by design (ADR-002), but that dedup must
// not reach the pointer tables: `file_mapping` records a version *of a path*.
// The ingestion path derived `fileVersionId` from the content hash alone, so
// ingesting project B's copy of an identical file deleted project A's row —
// and A's own file disappeared from a search scoped to A.
//
// The fixture corpus carries `alpha/src/shared.ts` and `beta/src/shared.ts`
// byte-identical for exactly this reason (test/fixtures/README.md).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { LanceDbSchema, FakeEmbeddingProvider } from "@prag/core";
import { Daemon } from "../src/daemon.js";

const TOKEN = "test-cross-project";
const HEADERS = { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };
const SHARED = "export function shared(): number { return 42; }\n";

async function call(port: number, path: string, body?: unknown, method = "POST") {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: HEADERS,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let parsed: unknown = null;
  try { parsed = JSON.parse(await res.text()); } catch { /* non-JSON */ }
  return { status: res.status, body: parsed as Record<string, any> };
}

function crossProjectSuite(): void {
  const ctx: { tmpDir: string; schema: LanceDbSchema | null; daemon: Daemon | null; port: number } =
    { tmpDir: "", schema: null, daemon: null, port: 0 };

  before(async () => {
    ctx.tmpDir = mkdtempSync(join(tmpdir(), "prag-cross-project-"));
    ctx.schema = new LanceDbSchema({
      dbPath: join(ctx.tmpDir, "lancedb"),
      embeddingDim: 4,
      maxVectorUnitTokens: 512,
      modelMaxSeqLength: 512,
    });
    await ctx.schema.init();
    ctx.daemon = new Daemon({
      port: 0, token: TOKEN, noExit: true, ingestion: { poolSize: 1, cooldownMs: 10 },
    });
    await ctx.daemon.start(ctx.schema, new FakeEmbeddingProvider(4));
    ctx.port = ctx.daemon.boundPort!;

    // Watched and synced one at a time, deliberately: when both are ingested
    // concurrently the merge races and inserts both rows, so the bug hides.
    // Sequentially the second ingest sees the first's row and overwrote it.
    for (const name of ["alpha", "beta"]) {
      const dir = join(ctx.tmpDir, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "shared.ts"), SHARED);
      writeFileSync(join(dir, `${name}-only.ts`), `export const ${name} = 1;\n`);
      const res = await call(ctx.port, "/projects/watch", { uri: `file://${dir}`, projectId: name });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      await call(ctx.port, "/sync", {});
    }
  });

  after(async () => {
    await ctx.daemon?.stop();
    await ctx.schema?.close();
    rmSync(ctx.tmpDir, { recursive: true, force: true });
  });

  void it("keeps one file_mapping row per path, not per content hash", async () => {
    const rows = await ctx.schema!.table("file_mapping").query().limit(100).toArray() as
      Array<{ projectId: string; uri: string }>;
    const uris = rows.map((r) => r.uri).sort();

    assert.equal(rows.length, 4, `expected 4 files, got ${JSON.stringify(uris)}`);
    assert.ok(uris.some((u) => u.endsWith("/alpha/shared.ts")), "alpha's copy was deleted");
    assert.ok(uris.some((u) => u.endsWith("/beta/shared.ts")), "beta's copy is missing");

    // Each copy belongs to the project whose tree it is in.
    const owner = (suffix: string) => rows.find((r) => r.uri.endsWith(suffix))?.projectId;
    assert.equal(owner("/alpha/shared.ts"), "alpha");
    assert.equal(owner("/beta/shared.ts"), "beta");
  });

  void it("finds the shared file from both projects, scoped to each", async () => {
    for (const name of ["alpha", "beta"]) {
      const res = await call(ctx.port, "/search", { query: "shared", limit: 10, projectId: name });
      const uris = ((res.body?.hits ?? []) as Array<{ uri: string }>).map((h) => h.uri);
      assert.ok(
        uris.some((u) => u.endsWith(`/${name}/shared.ts`)),
        `${name} cannot find its own shared.ts: ${JSON.stringify(uris)}`,
      );
      // ...and scoping still holds: no hit from the other project's tree.
      const other = name === "alpha" ? "beta" : "alpha";
      assert.ok(
        !uris.some((u) => u.includes(`/${other}/`)),
        `${name}'s search leaked ${other}'s files: ${JSON.stringify(uris)}`,
      );
    }
  });
}

void describe("cross-project identical files", crossProjectSuite);
