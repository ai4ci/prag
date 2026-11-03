// @prag/daemon — ingestion worker (runs in worker_threads)
//
// Receives a file path via parentPort, reads + chunks it using
// the tree-sitter structural chunker, and posts the result back.
// No database handles, no embedding model — just parse and return.

import { parentPort } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  chunkDocumentOrCode,
  detectLanguageFromPath,
  documentCategory,
  UNSUPPORTED_DOCUMENT_EXTENSIONS,
} from "@prag/core";
import { extractDocument } from "./document-extractor.js";

export interface WorkerInput {
  projectId: string;
  filePath: string;
  /** Pages of a paginated document to parse (ADR-003); the extractor's default when unset. */
  maxDocumentPages?: number;
}

export interface WorkerOutput {
  projectId: string;
  filePath: string;
  language: string;
  /** sha256 of the raw file bytes — the file_mapping content address. */
  contentHash: string;
  chunks: Array<{
    chunkHash: string;
    text: string;
    startLine: number;
    endLine: number;
    scopeContext: string | null;
  }>;
  error?: string;
}

/** Formats the MVP has no parser for — rejected by name, never chunked as text. */
export function unsupportedFormat(path: string): string | null {
  const ext = path.toLowerCase().match(/(\.[a-z0-9]+)$/)?.[1] ?? "";
  return UNSUPPORTED_DOCUMENT_EXTENSIONS.has(ext) ? ext : null;
}

const port = parentPort;
if (port) {
  port.on("message", async (input: WorkerInput) => {
    try {
      const rejected = unsupportedFormat(input.filePath);
      if (rejected) {
        const output: WorkerOutput = {
          projectId: input.projectId,
          filePath: input.filePath,
          language: "unknown",
          contentHash: "",
          chunks: [],
          error: `UNSUPPORTED_FORMAT: no parser for ${rejected}`,
        };
        port.postMessage(output);
        return;
      }

      // A binary document is extracted to Markdown first (ADR-003). Its
      // content hash is over the *file bytes*, not the extracted text: ADR-017
      // addresses the file, and hashing the output would make an index rebuild
      // after a parser upgrade look like every document had changed.
      //
      // The extracted Markdown is chunked under a `.md` pseudo-path so the
      // heading chunker is selected -- the real path ends in `.pdf`, and
      // routing on it would send Markdown to the tree-sitter chunker.
      const category = documentCategory(input.filePath);
      let lang: string;
      let content: string;
      let contentHash: string;
      if (category) {
        const extracted = await extractDocument(input.filePath,
          { maxPages: input.maxDocumentPages });
        const bytes = await readFile(input.filePath);
        contentHash = createHash("sha256").update(bytes).digest("hex");
        content = extracted!.markdown;
        lang = extracted!.category;
      } else {
        lang = detectLanguageFromPath(input.filePath);
        content = await readFile(input.filePath, "utf-8");
        contentHash = createHash("sha256").update(content).digest("hex");
      }
      const chunked = chunkDocumentOrCode(
        category ? `${input.filePath}.md` : input.filePath,
        content,
      );

      const output: WorkerOutput = {
        projectId: input.projectId,
        filePath: input.filePath,
        language: lang,
        contentHash,
        chunks: chunked.chunks.map((c) => ({
          chunkHash: c.chunkHash,
          text: c.text,
          startLine: c.startLine,
          endLine: c.endLine,
          scopeContext: c.scopeContext,
        })),
      };

      port.postMessage(output);
    } catch (err) {
      const output: WorkerOutput = {
        projectId: input.projectId,
        filePath: input.filePath,
        language: "unknown",
        contentHash: "",
        chunks: [],
        error: (err as Error).message,
      };
      port.postMessage(output);
    }
  });
}
