import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import lancedb, { Index } from "@lancedb/lancedb";
import { Table, Schema, Field, Utf8, Int32, Float32, FixedSizeList } from "apache-arrow";
import { FakeEmbeddingProvider } from "./embedding.js";

// We import the search module dynamically to avoid type issues
const { hybridSearch, fuseResults } = await import("./search.js") as any;

void describe("search", () => {
  let tmpDir: string;
  let db: any;
  let chunksTable: any;
  let vectorsTable: any;
  let chunkMapping: any;
  let fileMapping: any;
  let embedder: FakeEmbeddingProvider;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "prag-search-"));
    db = await lancedb.connect(tmpDir);

    // ── file_mapping ────────────────────────────────────────────
    {
      const schema = new Schema([
        new Field("fileVersionId", new Utf8(), false),
        new Field("uri", new Utf8(), false),
        new Field("language", new Utf8(), false),
        new Field("contentHash", new Utf8(), false),
      ]);
      fileMapping = await db.createTable("file_mapping", [
        { fileVersionId: "fv1", uri: "src/hello.ts", language: "typescript", contentHash: "h1" },
        { fileVersionId: "fv2", uri: "src/goodbye.py", language: "python", contentHash: "h2" },
      ], { primaryKey: "fileVersionId", mode: "create" });
    }

    // ── chunk_mapping ───────────────────────────────────────────
    {
      const schema = new Schema([
        new Field("fileVersionId", new Utf8(), false),
        new Field("chunkIndex", new Int32(), false),
        new Field("chunkHash", new Utf8(), false),
      ]);
      chunkMapping = await db.createTable("chunk_mapping", [
        { fileVersionId: "fv1", chunkIndex: 0, chunkHash: "ch1" },
        { fileVersionId: "fv1", chunkIndex: 1, chunkHash: "ch2" },
        { fileVersionId: "fv2", chunkIndex: 0, chunkHash: "ch3" },
      ], { primaryKey: "fileVersionId", mode: "create" });
    }

    // ── chunks_pool ─────────────────────────────────────────────
    {
      const schema = new Schema([
        new Field("chunkHash", new Utf8(), false),
        new Field("text", new Utf8(), false),
        new Field("scopeContext", new Utf8(), true),
      ]);
      chunksTable = await db.createTable("chunks_pool", [
        { chunkHash: "ch1", text: "hello world foo bar", scopeContext: null },
        { chunkHash: "ch2", text: "another hello method here", scopeContext: "Hello.greet" },
        { chunkHash: "ch3", text: "goodbye cruel world", scopeContext: null },
      ], { primaryKey: "chunkHash", mode: "create" });
      await chunksTable.createIndex("text", { config: Index.fts() });
    }

    // ── vector_pool (4-d for fake embeddings) ──────────────────────
    {
      const tSchema = new Schema([
        new Field("chunkHash", new Utf8(), false),
        new Field("unitIndex", new Int32(), false),
        new Field("vector", new FixedSizeList(4, new Field("item", new Float32(), true))),
      ]);
      vectorsTable = await db.createTable("vector_pool", [], {
        primaryKey: "chunkHash",
        mode: "create",
        schema: tSchema,
      });

      // Add vectors
      const _emb = new FakeEmbeddingProvider(4);
      const v1 = await _emb.embed("hello world foo bar");
      const v2 = await _emb.embed("another hello method here");
      const v3 = await _emb.embed("goodbye cruel world");

      await vectorsTable.add([
        { chunkHash: "ch1", unitIndex: 0, vector: Array.from(v1) },
        { chunkHash: "ch2", unitIndex: 0, vector: Array.from(v2) },
        { chunkHash: "ch3", unitIndex: 0, vector: Array.from(v3) },
      ]);
      await vectorsTable.createIndex("vector", { config: Index.ivfPq() });
    }

    embedder = new FakeEmbeddingProvider(4);
  });

  after(async () => {
    await db?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  void it("returns file-level results for a query", async () => {
    const result = await hybridSearch(
      chunksTable, vectorsTable, chunkMapping, fileMapping,
      embedder, "hello", 5,
    );

    assert.ok(result.hits.length >= 1, "should find at least one file");
    assert.ok(result.hits[0].uri, "should have file URI");
    assert.ok(result.hits[0].chunks.length >= 1, "should have chunks");
  });

  void it("ranks hello-related files higher than goodbye for 'hello'", async () => {
    const result = await hybridSearch(
      chunksTable, vectorsTable, chunkMapping, fileMapping,
      embedder, "hello", 5,
    );

    // "hello world" (fv1) should rank above "goodbye cruel world" (fv2)
    const fv1 = result.hits.find((h: any) => h.fileVersionId === "fv1");
    const fv2 = result.hits.find((h: any) => h.fileVersionId === "fv2");
    assert.ok(fv1, "fv1 should be in results");
    assert.ok(fv2, "fv2 should be in results");
    assert.ok(
      fv1.score >= fv2.score,
      `fv1 score (${fv1.score}) should >= fv2 score (${fv2.score})`,
    );
  });

  void it("returns totalChunks count", async () => {
    const result = await hybridSearch(
      chunksTable, vectorsTable, chunkMapping, fileMapping,
      embedder, "hello", 5,
    );
    assert.ok(result.totalChunks >= 0);
    assert.equal(result.query, "hello");
  });
});
