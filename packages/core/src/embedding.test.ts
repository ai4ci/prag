import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FakeEmbeddingProvider,
  getProvider,
  registerProvider,
  parseFakeDim,
} from "./embedding.js";

void describe("FakeEmbeddingProvider", () => {
  void it("produces deterministic vectors for the same text", async () => {
    const p = new FakeEmbeddingProvider(384);
    const a = await p.embed("hello world");
    const b = await p.embed("hello world");
    assert.deepEqual(a, b);
  });

  void it("produces different vectors for different text", async () => {
    const p = new FakeEmbeddingProvider(384);
    const a = await p.embed("hello world");
    const b = await p.embed("goodbye world");
    assert.notDeepEqual(a, b);
  });

  void it("returns vectors of the configured dimension", async () => {
    const p = new FakeEmbeddingProvider(128);
    const v = await p.embed("test");
    assert.equal(v.length, 128);
  });

  void it("defaults to 384 dimensions", () => {
    const p = new FakeEmbeddingProvider();
    assert.equal(p.dim, 384);
    assert.equal(p.model, "fake:384");
  });

  void it("produces unit-length vectors", async () => {
    const p = new FakeEmbeddingProvider(64);
    const v = await p.embed("some text");
    const norm = Math.sqrt(
      Array.from(v).reduce((sum, x) => sum + x * x, 0),
    );
    assert.ok(Math.abs(norm - 1) < 1e-6, `norm=${norm}`);
  });

  void it("embedBatch returns matching results for same texts", async () => {
    const p = new FakeEmbeddingProvider(64);
    const results = await p.embedBatch(["a", "a", "b"]);
    assert.equal(results.length, 3);
    assert.deepEqual(results[0], results[1]);
    assert.notDeepEqual(results[0], results[2]);
  });

  void it("declares a reasonable maxSeqLength", () => {
    const p = new FakeEmbeddingProvider();
    assert.ok(p.maxSeqLength > 0);
    assert.equal(p.maxSeqLength, 512);
  });
});

void describe("getProvider / registerProvider", () => {
  void it("returns a FakeEmbeddingProvider for fake:384", () => {
    const p = getProvider("fake:384");
    assert.ok(p instanceof FakeEmbeddingProvider);
    assert.equal(p.dim, 384);
  });

  void it("accepts custom dim via fake:128", () => {
    const p = getProvider("fake:128");
    assert.ok(p instanceof FakeEmbeddingProvider);
    assert.equal(p.dim, 128);
  });

  void it("throws for unregistered model", () => {
    assert.throws(() => getProvider("unknown:123"), /No embedding provider/);
  });

  void it("allows registering a custom provider", () => {
    registerProvider("custom:", (m) => {
      const dim = parseInt(m.split(":")[1] ?? "64", 10);
      return new FakeEmbeddingProvider(dim);
    });
    const p = getProvider("custom:64");
    assert.ok(p instanceof FakeEmbeddingProvider);
    assert.equal(p.model, "fake:64");
  });
});

void describe("parseFakeDim", () => {
  void it("parses fake:384", () => assert.equal(parseFakeDim("fake:384"), 384));
  void it("parses fake_768", () => assert.equal(parseFakeDim("fake_768"), 768));
  void it("throws for invalid format", () => {
    assert.throws(() => parseFakeDim("fake"), /Invalid fake model/);
    assert.throws(() => parseFakeDim("real:384"), /Invalid fake model/);
  });
});
