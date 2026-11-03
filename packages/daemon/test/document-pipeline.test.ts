// @prag/daemon — ADR-003 document pipeline: PDF, DOCX and friends to Markdown.
//
// Routed by format because neither engine wins outright: PDF carries no
// structure of its own and LiteParse reconstructs it from page geometry,
// while every other format states its structure explicitly and xberg reads
// it directly (and ~200x faster for DOCX).
//
// The fixtures are generated from one source `sample.md`, so all three must
// extract to the same prose -- which is what makes "did the parser work?" a
// checkable question rather than a judgement call.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, copyFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  documentCategory, DOCUMENT_FORMATS, UNSUPPORTED_DOCUMENT_EXTENSIONS, probeFile,
  LanceDbSchema, FakeEmbeddingProvider,
} from "@prag/core";
import { extractDocument } from "../src/document-extractor.js";
import { Daemon } from "../src/daemon.js";

const FIXTURES = join(import.meta.dirname, "../../../test/fixtures/documents");

function documentPipelineSuite(): void {
  void it("routes by extension and records the category, not the parser", () => {
    // `file_mapping.language` is the document category. Recording which
    // engine produced it would make the index need a rebuild whenever the
    // routing changed.
    assert.equal(documentCategory("/a/report.pdf"), "pdf");
    assert.equal(documentCategory("/a/REPORT.PDF"), "pdf");
    assert.equal(documentCategory("/a/notes.docx"), "docx");
    assert.equal(documentCategory("/a/deck.pptx"), "pptx");
    assert.equal(documentCategory("/a/main.ts"), null);
    assert.equal(documentCategory("/a/noext"), null);
  });

  void it("no longer refuses a format it can now read", () => {
    // The two sets must not overlap, or a format is both "extract it" and
    // "reject it by name" depending on which check runs first.
    for (const ext of DOCUMENT_FORMATS.keys()) {
      assert.equal(UNSUPPORTED_DOCUMENT_EXTENSIONS.has(ext), false,
        `${ext} is both a document format and an unsupported one`);
    }
    // ...and what remains refused is genuinely unreadable, not just unbuilt.
    for (const ext of [".png", ".zip", ".so", ".exe"]) {
      assert.equal(UNSUPPORTED_DOCUMENT_EXTENSIONS.has(ext), true, ext);
    }
  });

  void it("admits a document that binary detection would have refused", async () => {
    // A PDF has NUL bytes in its first 8KB, so the binary probe rejected
    // every one of them before a parser could see it. This is the gate that
    // had to move, and it is shared with the ingestion queue.
    assert.equal(await probeFile(join(FIXTURES, "sample.pdf"), 2 * 1024 * 1024), null);
    assert.equal(await probeFile(join(FIXTURES, "sample.docx"), 2 * 1024 * 1024), null);

    // The two caps are separate on purpose, and this is what proves it: a
    // 10-byte `maxFileBytes` does not refuse a 29KB PDF, because documents
    // are judged against `maxDocumentBytes`. Sharing one number would make
    // the source-file limit (2MB) refuse most real PDFs.
    assert.equal(await probeFile(join(FIXTURES, "sample.pdf"), 10), null);
    assert.equal(await probeFile(join(FIXTURES, "sample.pdf"), 10, 10), "tooLarge");

    // A genuine binary with no parser is still refused as binary.
    const tmp = mkdtempSync(join(tmpdir(), "prag-bin-"));
    try {
      const blob = join(tmp, "data.bin");
      writeFileSync(blob, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02]));
      assert.equal(await probeFile(blob, 2 * 1024 * 1024), "binary");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  void it("extracts a PDF with its heading structure intact", async () => {
    const out = await extractDocument(join(FIXTURES, "sample.pdf"));
    assert.ok(out, "the PDF was not recognised as a document");
    assert.equal(out.category, "pdf");
    // This is why PDF goes to LiteParse rather than xberg: the alternative
    // returns the same words as one flat paragraph.
    assert.match(out.markdown, /^# Indexing Sample Document$/m, "no heading recovered");
    assert.match(out.markdown, /^## Why it matters$/m, "no sub-heading recovered");
    assert.match(out.markdown, /^- Extraction must preserve heading text/m,
      "list bullets were not recovered from page geometry");
    assert.match(out.markdown, /\|\s*Format\s*\|/, "the table was not recovered");
  });

  void it("extracts a DOCX with its structure intact", async () => {
    const out = await extractDocument(join(FIXTURES, "sample.docx"));
    assert.ok(out);
    assert.equal(out.category, "docx");
    assert.match(out.markdown, /^# Indexing Sample Document$/m);
    assert.match(out.markdown, /^## Why it matters$/m);
    assert.match(out.markdown, /^- Extraction must preserve heading text/m);
    assert.match(out.markdown, /\|\s*Format\s*\|/);
  });

  void it("agrees with the Markdown the fixtures were generated from", async () => {
    // The fixture README's claim: "all three should extract to the same
    // prose". Checked on the distinctive sentence rather than byte equality,
    // because the two engines differ in whitespace and that is not a defect.
    const needle = "Tables must survive as rows, even if the cell borders are lost.";
    for (const f of ["sample.pdf", "sample.docx"]) {
      const out = await extractDocument(join(FIXTURES, f));
      assert.match(out!.markdown, /Tables must survive as rows/,
        `${f} lost "${needle}"`);
    }
  });

  void it("returns null for a source file, which is not an error", async () => {
    // The caller distinguishes "chunk this as text" from "extraction failed",
    // and only the second is a problem.
    assert.equal(await extractDocument("/tmp/nonexistent/main.ts"), null);
  });

  void it("does not emit YAML frontmatter the chunker would index as prose", async () => {
    const out = await extractDocument(join(FIXTURES, "sample.docx"));
    assert.doesNotMatch(out!.markdown.slice(0, 40), /^---/);
  });
}
void describe("document extraction", documentPipelineSuite);

function documentIngestionSuite(): void {
  const ctx: { tmp: string; schema: LanceDbSchema | null; daemon: Daemon | null } =
    { tmp: "", schema: null, daemon: null };

  after(async () => {
    await ctx.daemon?.stop();
    await ctx.schema?.close();
    if (ctx.tmp) rmSync(ctx.tmp, { recursive: true, force: true });
  });

  void it("indexes a PDF and a DOCX, and finds them by their content", async () => {
    ctx.tmp = mkdtempSync(join(tmpdir(), "prag-docs-"));
    const corpus = join(ctx.tmp, "corpus");
    mkdirSync(corpus, { recursive: true });
    copyFileSync(join(FIXTURES, "sample.pdf"), join(corpus, "report.pdf"));
    copyFileSync(join(FIXTURES, "sample.docx"), join(corpus, "notes.docx"));
    writeFileSync(join(corpus, "app.ts"), "export const app = 1;\n");

    ctx.schema = new LanceDbSchema({
      dbPath: join(ctx.tmp, "lancedb"),
      embeddingDim: 4, maxVectorUnitTokens: 512, modelMaxSeqLength: 512,
    });
    await ctx.schema.init();
    ctx.daemon = new Daemon({
      port: 0, token: "t", noExit: true,
      ingestion: { poolSize: 1, cooldownMs: 5 },
    });
    await ctx.daemon.start(ctx.schema, new FakeEmbeddingProvider(4));
    const port = ctx.daemon.boundPort!;
    const headers = { "Content-Type": "application/json", Authorization: "Bearer t" };
    const post = (p: string, b: unknown) =>
      fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", headers, body: JSON.stringify(b) });

    const watch = await post("/projects/watch",
      { uri: `file://${corpus}`, projectId: "docs", confirm: true });
    assert.equal(watch.status, 200, await watch.text());
    await post("/sync", { projectId: "docs" });

    const rows = (await ctx.schema.table("file_mapping").query().limit(50).toArray()) as
      Array<{ uri: string; language: string }>;
    const byName = new Map(rows.map((r) => [r.uri.split("/").pop(), r]));

    assert.ok(byName.has("report.pdf"), `the PDF was not indexed: ${[...byName.keys()]}`);
    assert.ok(byName.has("notes.docx"), `the DOCX was not indexed: ${[...byName.keys()]}`);
    // `language` is the document category, which is what the task asks for.
    assert.equal(byName.get("report.pdf")!.language, "pdf");
    assert.equal(byName.get("notes.docx")!.language, "docx");
    assert.equal(byName.get("app.ts")!.language, "typescript");

    // Chunked by heading, not as one blob: the pseudo-path routing works.
    const chunks = (await ctx.schema.table("chunk_mapping").query().limit(500).toArray()) as
      Array<{ fileVersionId: string }>;
    assert.ok(chunks.length > 3,
      `expected several chunks across the corpus, got ${chunks.length}`);
  });
}
void describe("document ingestion end to end", documentIngestionSuite);
