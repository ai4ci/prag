// @prag/daemon — binary documents to Markdown (ADR-003).
//
// Two engines, routed by format, because measurement said neither wins
// outright (`task:liteparse-document-pipeline.md`). On this repository's own
// fixtures:
//
//   | | LiteParse | xberg |
//   |---|---|---|
//   | PDF  | 5ms, headings + bullets + a real table | 12ms, flat prose |
//   | DOCX | 444ms, full structure | 2ms, identical output |
//
// PDF carries no structure of its own -- heading levels and table borders
// have to be reconstructed from where the glyphs sit on the page -- and that
// reconstruction is what LiteParse is. Every other format states its
// structure explicitly, and rendering it to pages to re-derive what the file
// already said is both slower and lossier, so those go to xberg.
//
// Output is Markdown in both cases, which the existing heading chunker then
// splits. Nothing here chunks, embeds or writes.

import { readFile } from "node:fs/promises";
import {
  documentCategory,
  DEFAULT_MAX_DOCUMENT_PAGES,
} from "@prag/core";

export interface ExtractedDocument {
  /** Markdown, ready for `chunkDocumentOrCode` via a `.md` pseudo-path. */
  markdown: string;
  /** The `language` recorded in `file_mapping`: "pdf", "docx", ... */
  category: string;
  /** Pages parsed, for paginated formats. */
  pages?: number;
  /** True when `maxPages` cut the document short. */
  truncated?: boolean;
}

export interface ExtractOptions {
  /** Pages parsed before the rest is dropped; default 500. */
  maxPages?: number | undefined;
}

/**
 * LiteParse holds a PDFium handle and a worker pool, so it is built once and
 * reused. One per worker thread, which is where this module runs.
 */
let liteParse: { parse: (p: string) => Promise<LiteParseResult> } | null = null;

interface LiteParseResult {
  totalPages: number;
  pages: Array<{ markdown?: string }>;
}

async function pdfToMarkdown(
  filePath: string,
  maxPages: number,
): Promise<ExtractedDocument> {
  if (!liteParse) {
    const { LiteParse } = await import("@llamaindex/liteparse");
    liteParse = new LiteParse({
      outputFormat: "markdown",
      // Per-page timings on stdout would interleave with the daemon's own
      // log for every document indexed.
      quiet: true,
      maxPages,
      // One unreadable page must not lose the other 400.
      continueOnPageError: true,
      // OCR is off: it is slow, non-deterministic enough to churn chunk
      // hashes between runs, and `feature:local-first-runtime.md` means a
      // parser must not reach for a model that is not already here. A
      // scanned PDF therefore yields little text, which is honest -- better
      // than silently taking minutes per file.
      ocrEnabled: false,
      extractImages: false,
      extractScreenshots: false,
    }) as unknown as typeof liteParse;
  }
  const result = await liteParse!.parse(filePath) as LiteParseResult;
  const markdown = result.pages
    .map((p) => p.markdown ?? "")
    .filter((m) => m.trim() !== "")
    .join("\n\n");
  return {
    markdown,
    category: "pdf",
    pages: result.pages.length,
    truncated: result.totalPages > result.pages.length,
  };
}

/**
 * xberg's configuration, stated rather than inherited.
 *
 * `doctor()` reports several optional models as "not cached locally; first
 * use may download it" -- layout detection, table structure, formula OCR.
 * None is on the default path, but `feature:local-first-runtime.md` is a
 * guarantee and not a default, so OCR is pinned off here the same way
 * crawlberg's SSRF policy is pinned in ADR-024: the decision is prag's, not
 * the library's.
 */
const XBERG_CONFIG = {
  outputFormat: "markdown",
  disableOcr: true,
  // Metadata as YAML frontmatter would be read by the heading chunker as
  // content. The title is in `metadata` and is not needed in the body.
  extractMetadata: false,
} as const;

async function fileToMarkdown(
  filePath: string,
  category: string,
): Promise<ExtractedDocument> {
  const xberg = await import("@xberg-io/xberg");
  const bytes = await readFile(filePath);
  const result = await xberg.extract(
    { kind: xberg.ExtractInputKind.Bytes, bytes, filename: basenameOf(filePath) },
    XBERG_CONFIG,
  );
  if (result.errors?.length) {
    throw new Error(`${category} extraction failed: ${result.errors[0].message}`);
  }
  const doc = result.results?.[0];
  if (!doc) throw new Error(`${category} extraction returned no document`);
  return {
    markdown: doc.content ?? "",
    category,
    pages: doc.counts?.pages || undefined,
  };
}

/** The last path segment, on either separator. */
function basenameOf(filePath: string): string {
  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1] || filePath;
}

/**
 * Convert a binary document to Markdown, or return `null` if the path is not
 * a document this build can read.
 *
 * `null` rather than a throw: the caller distinguishes "this is a source
 * file, chunk it as text" from "this is a document and extraction failed",
 * and only the second is an error.
 */
export async function extractDocument(
  filePath: string,
  opts: ExtractOptions = {},
): Promise<ExtractedDocument | null> {
  const category = documentCategory(filePath);
  if (!category) return null;
  return category === "pdf"
    ? pdfToMarkdown(filePath, opts.maxPages ?? DEFAULT_MAX_DOCUMENT_PAGES)
    : fileToMarkdown(filePath, category);
}
