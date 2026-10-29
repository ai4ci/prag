// @prag/core — File chunking pipeline using tree-sitter-language-pack
//
// Uses `@kreuzberg/tree-sitter-language-pack` for Tree-sitter AST parsing and
// structural chunking (ADR-023). Falls back to paragraph splitting for languages
// the pack does not support.

import { createHash } from "node:crypto";
import pack from "@kreuzberg/tree-sitter-language-pack";

// ── Types ─────────────────────────────────────────────────────────────

export interface Chunk {
  /** SHA-256 of the normalized chunk text. */
  chunkHash: string;
  /** The raw chunk text for storage in chunks_pool. */
  text: string;
  /** Whitespace-normalized text used for hash calculation. */
  normalized: string;
  /** 0-based index within the source file. */
  index: number;
  /** 0-based start line in the source file. */
  startLine: number;
  /** 0-based end line (exclusive). */
  endLine: number;
  /** Hierarchical scope context (e.g. "File: src/main.ts > Class: Hello > Method: greet"). */
  scopeContext: string | null;
}

export interface ChunkedFile {
  /** Language identifier used by tree-sitter (e.g. "typescript", "python"). */
  language: string;
  /** All chunks from this file. */
  chunks: Chunk[];
}

// ── Language detection ────────────────────────────────────────────────

/**
 * Detect language using tree-sitter-language-pack, with fallback for
 * extension → language name mapping.
 */
export function detectLanguageFromPath(path: string): string {
  const lang = pack.detectLanguageFromPath(path);
  if (lang) return lang;

  // Fallback for common extensions the pack might miss
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const fallback: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    mjs: "javascript",
    cjs: "javascript",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    rb: "ruby",
    php: "php",
    r: "r",
    md: "markdown",
    mdx: "markdown",
    yml: "yaml",
    yaml: "yaml",
    json: "json",
    toml: "toml",
    txt: "text",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    css: "css",
    html: "html",
    sql: "sql",
    pdf: "pdf",
    docx: "docx",
  };
  return fallback[ext] ?? "text";
}

// ── Whitespace normalization (ADR-014) ────────────────────────────────

export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, "  ")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .trimEnd() + "\n";
}

// ── Chunk hashing ─────────────────────────────────────────────────────

export function chunkHash(text: string): string {
  return createHash("sha256")
    .update(normalizeWhitespace(text))
    .digest("hex");
}

// ── Fallback: paragraph splitting ─────────────────────────────────────
// Used when tree-sitter chunking is not available or the pack does not
// support the detected language.

function fallbackChunk(path: string, content: string): ChunkedFile {
  const lang = detectLanguageFromPath(path);
  const paragraphs = content.split(/\n\n+/);
  const chunks: Chunk[] = [];
  let lineOffset = 0;

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (trimmed.length < 20) {
      lineOffset += para.split("\n").length;
      continue;
    }

    const lines = trimmed.split("\n");
    chunks.push({
      chunkHash: chunkHash(trimmed),
      text: trimmed,
      normalized: normalizeWhitespace(trimmed),
      index: chunks.length,
      startLine: lineOffset,
      endLine: lineOffset + lines.length,
      scopeContext: null,
    });
    lineOffset += lines.length + 1; // +1 for the blank line separator
  }

  if (chunks.length === 0 && content.trim().length > 0) {
    chunks.push({
      chunkHash: chunkHash(content.trim()),
      text: content.trim(),
      normalized: normalizeWhitespace(content.trim()),
      index: 0,
      startLine: 0,
      endLine: content.split("\n").length,
      scopeContext: null,
    });
  }

  return { language: lang, chunks };
}

// ── Main chunking entry point ─────────────────────────────────────────
// shortcut: `chunkMaxSize` tuned by file size. Upgrade to per-language
// tuned values when we have profiling data.

const DEFAULT_CHUNK_MAX_SIZE = 2000;

/**
 * Split file content into structural chunks using tree-sitter.
 *
 * Uses `@kreuzberg/tree-sitter-language-pack` to:
 * 1. Detect the language from the file path.
 * 2. Parse the file with Tree-sitter.
 * 3. Split on structural boundaries (functions, classes, methods).
 * 4. Map structure items to chunks for scope context annotations.
 *
 * Falls back to paragraph splitting for unsupported languages.
 */
export function chunkFile(
  path: string,
  content: string,
  options?: { maxChunkBytes?: number },
): ChunkedFile {
  const language = detectLanguageFromPath(path);

  // For binary/doc formats, use fallback
  if (language === "pdf" || language === "docx") {
    return fallbackChunk(path, content);
  }

  // Check if this language is available in tree-sitter
  if (!pack.hasLanguage(language)) {
    return fallbackChunk(path, content);
  }

  const maxBytes = options?.maxChunkBytes ?? DEFAULT_CHUNK_MAX_SIZE;

  // Parse and chunk with tree-sitter
  const result = pack.process(content, {
    language,
    chunkMaxSize: maxBytes,
    structure: true,
  });

  const chunks: Chunk[] = [];
  const seenHashes = new Set<string>();

  // Map structure items by line range for scope context
  const scopeMap = buildScopeMap(result.structure ?? []);

  // Track next expected chunk from structure positions for dedup later
  for (const codeChunk of result.chunks ?? []) {
    const text = (codeChunk.content ?? "").trim();
    if (!text) continue;

    const nHash = chunkHash(text);
    if (seenHashes.has(nHash)) continue;
    seenHashes.add(nHash);

    const contextPath = codeChunk.metadata?.contextPath;

    // Try to find corresponding structure items for scope context
    let scopeContext: string | null = null;
    if (contextPath && contextPath.length > 0) {
      scopeContext = `File: ${path} > ${contextPath.map((s) => `... > ${s}`).join("")}`;
    } else {
      // Deduce scope from structure items overlapping this chunk's lines
      const cl = codeChunk.startLine ?? 0;
      const ce = codeChunk.endLine ?? 0;
      const matched = scopeMap.filter(
        (s) => s.startLine <= ce && s.endLine >= cl,
      );
      if (matched.length > 0) {
        scopeContext = `File: ${path} > ${matched.map((s) => `${s.kind}: ${s.name}`).join(" > ")}`;
      }
    }

    chunks.push({
      chunkHash: nHash,
      text,
      normalized: normalizeWhitespace(text),
      index: chunks.length,
      startLine: codeChunk.startLine ?? 0,
      endLine: codeChunk.endLine ?? 0,
      scopeContext,
    });
  }

  // If tree-sitter produced no chunks, fall back
  if (chunks.length === 0) {
    return fallbackChunk(path, content);
  }

  return { language, chunks };
}

// ── Scope helpers ─────────────────────────────────────────────────────

interface ScopeEntry {
  kind: string;
  name: string;
  startLine: number;
  endLine: number;
}

function buildScopeMap(items: any[]): ScopeEntry[] {
  const result: ScopeEntry[] = [];

  function walk(items: any[]) {
    for (const item of items) {
      const span = item.span;
      if (span) {
        result.push({
          kind: item.kind ?? "Item",
          name: item.name ?? "<anonymous>",
          startLine: span.startLine ?? 0,
          endLine: span.endLine ?? 0,
        });
      }
      if (item.children) {
        walk(item.children);
      }
    }
  }

  walk(items);
  return result;
}
