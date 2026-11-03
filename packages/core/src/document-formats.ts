// @prag/core — which binary formats have a document parser (ADR-003).
//
// This lives in core, and holds no parser, because three places have to agree
// about it and they cannot all reach the parsers: the discovery dry run (what
// `prag watch` promises to index), the ingestion queue's admission gate, and
// the worker that actually extracts. A format listed here is one the daemon
// will convert to Markdown; the extraction itself is `@prag/daemon`'s
// `document-extractor.ts`, because both engines are native addons and core is
// on the CLI's import path.

/**
 * Extension to the `language` recorded in `file_mapping`.
 *
 * The value is the document *category*, not the parser that produced it
 * (`task:liteparse-document-pipeline.md`): which engine handled a `.docx` is
 * an implementation detail that may change, and an index that recorded it
 * would have to be rebuilt when it did.
 */
export const DOCUMENT_FORMATS: ReadonlyMap<string, string> = new Map([
  // Page-geometry formats. PDF goes to LiteParse, which reconstructs heading
  // levels, list bullets and table structure from layout; the alternative
  // returns flat prose.
  [".pdf", "pdf"],
  // Formats that carry their own structure, so a format-aware extractor beats
  // re-deriving it from a rendering. These go to xberg.
  [".docx", "docx"],
  [".doc", "doc"],
  [".odt", "odt"],
  [".rtf", "rtf"],
  [".pptx", "pptx"],
  [".ppt", "ppt"],
  [".odp", "odp"],
  [".xlsx", "xlsx"],
  [".xls", "xls"],
  [".ods", "ods"],
  [".epub", "epub"],
  [".ipynb", "notebook"],
]);

/** The document category for a path, or `null` if it is not a document. */
export function documentCategory(filePath: string): string | null {
  const ext = filePath.toLowerCase().match(/(\.[a-z0-9]+)$/)?.[1] ?? "";
  return DOCUMENT_FORMATS.get(ext) ?? null;
}

/**
 * Bytes a document may occupy before it is skipped.
 *
 * Separate from `ingestion.maxFileBytes`, which is 2MB and is sized for
 * source files. A 2MB cap applied to documents would reject most real PDFs
 * before a parser ever saw them, so the two limits cannot be the same number.
 * 32MB holds a few hundred pages of text-layer PDF.
 */
export const DEFAULT_MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;

/**
 * Pages of a paginated document that are parsed, beyond which the rest is
 * dropped and the truncation recorded.
 *
 * A bound is needed because page count and byte size are only loosely
 * related: a scanned 2,000-page report can sit inside the byte cap and still
 * take minutes to parse and thousands of chunks to embed.
 */
export const DEFAULT_MAX_DOCUMENT_PAGES = 500;
