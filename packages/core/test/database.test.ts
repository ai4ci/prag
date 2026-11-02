import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import lancedb from "@lancedb/lancedb";
import { Schema, Field } from "apache-arrow";
import {
  LanceDbSchema,
  API_VERSION,
  ALL_TABLES,
  schemaDiff,
  upsertChunksPool,
  upsertFileMapping,
  upsertGrants,
  upsertProjects,
  upsertVectorPool,
} from "../src/database.js";
import { type VectorPoolRow } from "../src/schema.js";

// Tests against a real LanceDB instance in a temp dir
function lanceDbSchemaSuite(): void {
  let tmpDir: string;
  let db: LanceDbSchema;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "prag-core-test-"));
    db = new LanceDbSchema({ dbPath: tmpDir });
    await db.init();
  });

  after(async () => {
    await db?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  void it("creates all 7 tables on init", async () => {
    const tableNames = await db.db.tableNames();
    const expected = [
      "grants",
      "projects",
      "branch_mapping",
      "file_mapping",
      "chunk_mapping",
      "chunks_pool",
      "vector_pool",
    ];

    for (const name of expected) {
      assert.ok(
        tableNames.includes(name),
        `Expected table "${name}" to exist`,
      );
    }
    assert.equal(tableNames.length, expected.length);
  });

  void it("opens each table and reads its schema", async () => {
    for (const def of ALL_TABLES) {
      const table = db.table(def.name);
      const schema = await table.schema();
      assert.ok(schema, `Table "${def.name}" should have a schema`);
      assert.ok(
        schema.fields.length > 0,
        `Table "${def.name}" should have fields`,
      );
    }
    const vpTable = db.table("vector_pool");
    const vpSchema = await vpTable.schema();
    assert.ok(vpSchema.fields.length > 0);
  });

  void it("rejects oversized maxVectorUnitTokens", async () => {
    const badDir = mkdtempSync(join(tmpdir(), "prag-bad-"));
    try {
      const bad = new LanceDbSchema({
        dbPath: badDir,
        maxVectorUnitTokens: 1024,
        modelMaxSeqLength: 512,
      });
      await assert.rejects(
        () => bad.init(),
        { message: /exceeds/ },
      );
    } finally {
      rmSync(badDir, { recursive: true, force: true });
    }
  });

  void it("starts with a custom embedding dimension", async () => {
    const customDir = mkdtempSync(join(tmpdir(), "prag-custom-"));
    try {
      const custom = new LanceDbSchema({
        dbPath: customDir,
        embeddingDim: 768,
      });
      await custom.init();

      const vpTable = custom.table("vector_pool");
      const vpSchema = await vpTable.schema();
      const vecField = vpSchema.fields.find(
        (f: { name: string }) => f.name === "vector",
      );
      assert.ok(vecField, "vector field should exist");

      await custom.close();
    } finally {
      rmSync(customDir, { recursive: true, force: true });
    }
  });
}
void describe("LanceDbSchema", lanceDbSchemaSuite);

function vectorPoolSchemaSuite(): void {
  void it("accepts Float32Array as vector type", () => {
    const row: VectorPoolRow = {
      chunkHash: "abc123",
      unitIndex: 0,
      vector: new Float32Array([0.1, 0.2, 0.3]),
    };
    assert.equal(row.chunkHash, "abc123");
    assert.equal(row.unitIndex, 0);
    assert.equal(row.vector.length, 3);
  });
}
void describe("vectorPool schema", vectorPoolSchemaSuite);

function aPIVERSIONSuite(): void {
  void it("is a positive integer", () => {
    assert.ok(Number.isInteger(API_VERSION));
    assert.ok(API_VERSION > 0);
  });
}
void describe("API_VERSION", aPIVERSIONSuite);

// ── Schema verification on an existing table ──────────────────────────

function schemaVerificationSuite(): void {
  const roots: string[] = [];
  const fresh = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "prag-schema-"));
    roots.push(dir);
    return dir;
  };
  after(async () => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  void it("reopening a database written by this build is a no-op", async () => {
    // Includes a real write pass: the check compares against the *stored* schema,
    // so if mergeInsert narrowed a column or flipped nullability, every existing
    // index would start refusing to open. That is the failure mode to catch here.
    const dir = fresh();
    const a = new LanceDbSchema({ dbPath: dir, embeddingDim: 4 });
    await a.init();
    const now = new Date();
    await upsertGrants(a.table("grants"), [
      { pattern: "file:///x/**", action: "allow", reason: "watch_root", createdAt: now },
    ]);
    await upsertProjects(a.table("projects"), [
      {
        projectId: "file:///x", rootUri: "file:///x", name: "x", isGit: false,
        defaultCooldownSeconds: null, status: "idle", registeredAt: now, lastSyncedAt: null,
      },
    ]);
    await upsertFileMapping(a.table("file_mapping"), [
      { fileVersionId: "u::h", projectId: "file:///x", uri: "u", validUntil: null, contentHash: "h", language: "typescript" },
    ]);
    await upsertChunksPool(a.table("chunks_pool"), [
      { chunkHash: "h", text: "t", scopeContext: null },
    ]);
    await upsertVectorPool(a.table("vector_pool"), [
      { chunkHash: "h", unitIndex: 0, vector: new Float32Array(4) },
    ]);
    assert.equal(await a.table("chunks_pool").countRows(), 1);
    await a.close();

    const b = new LanceDbSchema({ dbPath: dir, embeddingDim: 4 });
    await b.init();
    assert.equal(await b.table("chunks_pool").countRows(), 1);
    assert.deepEqual((await b.table("vector_pool").schema()).names, ["chunkHash", "unitIndex", "vector"]);
    await b.close();
  });

  void it("refuses a table whose vector dimension changed", async () => {
    // The regression: dim 4 then dim 8 opened happily, because `openTable` never
    // looks at the schema. Worse, LanceDB does not reject the bad write either --
    // an 8-element vector added to a FixedSizeList(4) column is silently
    // *truncated* to 4 -- so a stale index keeps accepting rows whose embeddings
    // are quietly wrong, and search returns confidently ranked nonsense.
    const dir = fresh();
    const a = new LanceDbSchema({ dbPath: dir, embeddingDim: 4 });
    await a.init();
    await a.close();

    const b = new LanceDbSchema({ dbPath: dir, embeddingDim: 8 });
    await assert.rejects(() => b.init(), /vector_pool.*FixedSizeList<4>, want FixedSizeList<8>/s);
  });

  void it("refuses a missing column and names it", async () => {
    const dir = fresh();
    const a = new LanceDbSchema({ dbPath: dir, embeddingDim: 4 });
    await a.init();
    await a.close();
    // Simulate an older build whose chunks_pool had no scopeContext column.
    const db = await lancedb.connect(dir);
    await db.dropTable("chunks_pool");
    await db.createTable(
      "chunks_pool",
      [{ chunkHash: "h", text: "t" }],
      { mode: "create" },
    );
    await db.close();

    const b = new LanceDbSchema({ dbPath: dir, embeddingDim: 4 });
    await assert.rejects(() => b.init(), /missing column "scopeContext"/);
  });

  void it("schemaDiff compares by type, not by name", () => {
    const base = new LanceDbSchema({ dbPath: fresh(), embeddingDim: 4 });
    const want = ALL_TABLES.find((t) => t.name === "grants")!.schema;
    assert.deepEqual(schemaDiff(want, want), []);
    // Same field names, different nullability is still a difference.
    const flipped = new Schema(
      want.fields.map((f, i) => new Field(f.name, f.type, i === 0 ? !f.nullable : f.nullable)),
    );
    const diff = schemaDiff(want, flipped);
    assert.equal(diff.length, 1);
    assert.match(diff[0], /column "pattern" is/);
    void base;
  });

  void it("declares the composite keys storage-schema.md specifies", () => {
    const pk = new Map(ALL_TABLES.map((t) => [t.name, t.primaryKey]));
    assert.deepEqual(pk.get("branch_mapping"), ["branch", "projectId", "uri"]);
    assert.deepEqual(pk.get("chunk_mapping"), ["fileVersionId", "chunkIndex"]);
    assert.equal(pk.get("grants"), "pattern");
    // vector_pool is built per-dimension, so it is not in ALL_TABLES.
    const vp = new LanceDbSchema({ dbPath: fresh(), embeddingDim: 4 });
    void vp;
  });

  void it("refuses maxVectorUnitTokens above the provider's own window", async () => {
    // ADR-014: the comparison must be against the *active* model's ceiling, which
    // is why modelMaxSeqLength is injected. This asserts the injected value is the
    // one used: 1024 > 512 rejects even though 1024 would pass a hardcoded 2048.
    await assert.rejects(
      () =>
        new LanceDbSchema({
          dbPath: fresh(),
          maxVectorUnitTokens: 1024,
          modelMaxSeqLength: 512,
        }).init(),
      /exceeds/,
    );
  });
}
void describe("LanceDbSchema verification", schemaVerificationSuite);
