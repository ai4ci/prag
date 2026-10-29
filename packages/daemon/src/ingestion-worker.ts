// @prag/daemon — ingestion worker (runs in worker_threads)
//
// Receives a file path via parentPort, reads + chunks it using
// the tree-sitter structural chunker, and posts the result back.
// No database handles, no embedding model — just parse and return.

import { parentPort } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { chunkFile, detectLanguageFromPath } from "@prag/core";

export interface WorkerInput {
  projectId: string;
  filePath: string;
}

export interface WorkerOutput {
  projectId: string;
  filePath: string;
  language: string;
  chunks: Array<{
    chunkHash: string;
    text: string;
    startLine: number;
    endLine: number;
    scopeContext: string;
  }>;
  error?: string;
}

if (parentPort) {
  parentPort.on("message", async (input: WorkerInput) => {
    try {
      const lang = detectLanguageFromPath(input.filePath);
      const content = await readFile(input.filePath, "utf-8");
      const chunked = chunkFile(input.filePath, content, {
        chunkMaxSize: 512,
      });

      const output: WorkerOutput = {
        projectId: input.projectId,
        filePath: input.filePath,
        language: lang,
        chunks: chunked.chunks.map((c) => ({
          chunkHash: c.chunkHash,
          text: c.text,
          startLine: c.startLine,
          endLine: c.endLine,
          scopeContext: c.scopeContext,
        })),
      };

      parentPort.postMessage(output);
    } catch (err) {
      const output: WorkerOutput = {
        projectId: input.projectId,
        filePath: input.filePath,
        language: "unknown",
        chunks: [],
        error: (err as Error).message,
      };
      parentPort.postMessage(output);
    }
  });
}
