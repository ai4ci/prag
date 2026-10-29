import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LanceDbSchema, API_VERSION, ALL_TABLES } from "./database.js";
import { type VectorPoolRow } from "./schema.js";

// Tests against a real LanceDB instance in a temp dir
void describe("LanceDbSchema", () => {
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
});

void describe("vectorPool schema", () => {
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
});

void describe("API_VERSION", () => {
  void it("is a positive integer", () => {
    assert.ok(Number.isInteger(API_VERSION));
    assert.ok(API_VERSION > 0);
  });
});
