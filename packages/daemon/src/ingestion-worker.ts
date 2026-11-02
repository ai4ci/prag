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
  UNSUPPORTED_DOCUMENT_EXTENSIONS,
} from "@prag/core";

export interface WorkerInput {
  projectId: string;
  filePath: string;
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
          error: `UNSUPPORTED_FORMAT: no parser for ${rejected} (LiteParse is out of scope)`,
        };
        port.postMessage(output);
        return;
      }

      const lang = detectLanguageFromPath(input.filePath);
      const content = await readFile(input.filePath, "utf-8");
      const chunked = chunkDocumentOrCode(input.filePath, content);

      const output: WorkerOutput = {
        projectId: input.projectId,
        filePath: input.filePath,
        language: lang,
        contentHash: createHash("sha256").update(content).digest("hex"),
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
