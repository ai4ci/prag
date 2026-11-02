// @prag/core — Markdown chunking (document half of the parser router)
//
// The tree-sitter markdown grammar yields flat heading/paragraph nodes with no
// nesting, so heading structure is derived here instead. A chunk is one
// subsection — a heading plus its body including nested sub-headings — which is
// the same "never split a structural unit" rule as code, with ADR-014 windows
// handling anything oversized. Tables, lists and code fences stay inside the
// subsection they belong to (layout-preserving-chunking.md, no LiteParse).

import {
  chunkFile,
  chunkHash,
  detectLanguageFromPath,
  normalizeWhitespace,
  type Chunk,
  type ChunkedFile,
} from "./chunker.js";

/** ATX heading: 1–6 `#` then whitespace. */
const HEADING_RE = /^(#{1,6})[ \t]+(.*)$/;

interface HeadingLine {
  line: number;
  level: number;
  title: string;
}

/** Split a fenced code block's opening marker, if this line is one. */
const FENCE_RE = /^\s*(`{3,}|~{3,})/;

/**
 * The parser router (task:daemon-parser-router.md): markdown goes to the
 * heading chunker, everything else to the tree-sitter structural chunker.
 * PDF/DOCX have no parser yet — LiteParse is deliberately out of the MVP — so
 * they must be rejected by name upstream rather than chunked as text.
 */
export function chunkDocumentOrCode(
  path: string,
  content: string,
  options?: { maxChunkBytes?: number },
): ChunkedFile {
  const language = detectLanguageFromPath(path);
  if (language === "markdown") return chunkMarkdown(path, content);
  return chunkFile(path, content, options);
}

/** Chunk a markdown document by heading hierarchy. */
export function chunkMarkdown(path: string, content: string): ChunkedFile {
  const lines = normalizeWhitespace(content).split("\n");

  // Headings inside fenced code blocks are not headings.
  const headings: HeadingLine[] = [];
  const inFence: boolean[] = [];
  let fenceChar: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_RE.exec(lines[i]);
    if (fenceChar) {
      inFence[i] = true;
      if (lines[i].trimStart().startsWith(fenceChar)) fenceChar = null;
      continue;
    }
    if (open) {
      inFence[i] = true;
      fenceChar = open[1][0] === "`" ? "```" : "~~~";
      continue;
    }
    inFence[i] = false;
    const h = HEADING_RE.exec(lines[i]);
    if (h) {
      headings.push({ line: i, level: h[1].length, title: h[2].trim() || "<untitled>" });
    }
  }

  const chunks: Chunk[] = [];
  const seenHashes = new Set<string>();

  const push = (
    from: number,
    to: number, // exclusive
    scope: string | null,
  ): void => {
    const text = lines
      .slice(from, to)
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (!text) return;
    const hash = chunkHash(text);
    if (seenHashes.has(hash)) return; // repeated block within one file
    seenHashes.add(hash);
    chunks.push({
      chunkHash: hash,
      text,
      normalized: normalizeWhitespace(text),
      index: chunks.length,
      startLine: from,
      endLine: to,
      scopeContext: scope,
    });
  };

  // Enclosing heading chain, outermost first, for headings[i] inclusive.
  const scopeOf = (index: number): string => {
    const chain: string[] = [];
    let level = Infinity;
    for (let i = index; i >= 0; i--) {
      if (headings[i].level < level) {
        chain.unshift(`Heading: ${headings[i].title}`);
        level = headings[i].level;
        if (level === 1) break;
      }
    }
    return `File: ${path}${chain.length ? " > " + chain.join(" > ") : ""}`;
  };

  const bodyStart = (first: number): number => {
    // YAML front matter is metadata, not retrievable prose.
    if (first !== 0 || lines[0]?.trim() !== "---") return first;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") return i + 1;
    }
    return first;
  };

  if (headings.length === 0) {
    push(bodyStart(0), lines.length, `File: ${path}`);
    return { language: "markdown", chunks };
  }

  const preambleEnd = headings[0].line;
  if (preambleEnd > 0) {
    push(bodyStart(0), preambleEnd, `File: ${path}`);
  }

  for (let i = 0; i < headings.length; i++) {
    // A subsection ends at the next heading of the same or shallower level, so
    // nested headings stay inside their parent (and also surface on their own).
    let end = lines.length;
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].level <= headings[i].level) {
        end = headings[j].line;
        break;
      }
    }
    push(headings[i].line, end, scopeOf(i));
  }

  return { language: "markdown", chunks };
}
