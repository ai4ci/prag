// @prag/core — Ollama embedding provider
//
// Calls Ollama's /api/embed endpoint to generate vectors.
// ADR-006: real embedding via local LLM inference.

import { EmbeddingProvider, registerProvider } from "./embedding.js";

export interface OllamaConfig {
  /** Ollama server URL (default http://localhost:11434). */
  baseUrl?: string;
  /** Model name as Ollama knows it, e.g. "nomic-embed-text". */
  model: string;
  /** Expected embedding dimension. */
  dim: number;
  /** Max tokens for this model. */
  maxSeqLength?: number;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dim: number;
  readonly maxSeqLength: number;
  readonly baseUrl: string;
  private _embedModel: string;

  constructor(config: OllamaConfig) {
    this.baseUrl = config.baseUrl ?? "http://localhost:11434";
    this._embedModel = config.model;
    this.model = `ollama:${config.model}`;
    this.dim = config.dim;
    this.maxSeqLength = config.maxSeqLength ?? 512;

    // Validate we start with a recognised model family
    const known = ["nomic-embed-text", "mxbai-embed-large", "snowflake-arctic-embed"];
    if (!known.some((k) => config.model.startsWith(k))) {
      console.warn(
        `[prag] Unknown Ollama embedding model "${config.model}". ` +
          `Known models: ${known.join(", ")}. Dimension may be incorrect.`,
      );
    }
  }

  async embed(text: string): Promise<Float32Array> {
    const vectors = await this.embedBatch([text]);
    return vectors[0];
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this._embedModel, input: texts }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Ollama embed error (${res.status}): ${body.slice(0, 200)}`,
      );
    }

    const data = (await res.json()) as {
      embeddings: number[][];
    };

    if (!data.embeddings || data.embeddings.length !== texts.length) {
      throw new Error(
        `Ollama returned ${data.embeddings?.length ?? 0} embeddings for ` +
          `${texts.length} texts`,
      );
    }

    return data.embeddings.map(
      (arr) => new Float32Array(arr),
    );
  }
}

// Register so `getProvider("ollama:nomic-embed-text")` works
registerProvider("ollama:", (model) => {
  // "ollama:nomic-embed-text" -> "nomic-embed-text"
  const modelName = model.slice("ollama:".length);
  if (!modelName) throw new Error("Ollama model name required, e.g. ollama:nomic-embed-text");

  return new OllamaEmbeddingProvider({ model: modelName, dim: 768 });
});
