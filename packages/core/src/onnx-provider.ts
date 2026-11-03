// @prag/core — ONNX embedding provider (local, air-gapped inference)
//
// ADR-006: embeddings are computed on this machine. ADR-014: the reported
// maximum sequence length and the model's tokenizer drive vectorised-unit
// sizing, so this provider is the source of truth for both.
//
// Weights come from the Hugging Face hub on first use and are cached under
// ~/.cache/huggingface; after that no network is needed. Set
// PRAG_TRANSFERS_OFFLINE=1 to fail fast instead of reaching out.

import {
  type EmbeddingProvider,
  registerProvider,
} from "./embedding.js";
import { type Tokenizer } from "./vector-units.js";

// ── Config ────────────────────────────────────────────────────────────

export interface OnnxConfig {
  /** Hub model id, e.g. "Xenova/bge-small-en-v1.5". */
  model: string;
  /**
   * Quantisation. `q8` is ~4x smaller than `fp32` with a measurable-but-small
   * retrieval-quality cost; `fp32` is exact. Default `q8`.
   */
  dtype?: "q8" | "fp32" | "q4";
  /** Inference device ("cpu" | "cuda" | "webgpu"). Default "cpu". */
  device?: string;
  /** Models with an unknown ceiling still need a bound for ADR-014. */
  maxSeqLength?: number;
}

/**
 * Known ceilings, used only when the model config omits
 * `max_position_embeddings`. Everything else is read from the model itself, so
 * a config change cannot silently reintroduce truncation (ADR-014 clause 3).
 */
const KNOWN_MAX_SEQ: Record<string, number> = {
  "Xenova/bge-small-en-v1.5": 512,
  "Xenova/bge-base-en-v1.5": 512,
  "Xenova/nomic-embed-text-v1": 2048,
  "Xenova/all-MiniLM-L6-v2": 512,
};

// ── Provider ──────────────────────────────────────────────────────────

type Extractor = {
  (
    text: string | string[],
    options: { pooling: "mean"; normalize: boolean },
  ): Promise<{ data: Float32Array; dims: number[] }>;
  model: { config?: { max_position_embeddings?: number; hidden_size?: number } };
  tokenizer: {
    encode(text: string, opts?: { addSpecialTokens: boolean }): ArrayLike<number> & { slice(a: number, b: number): ArrayLike<number> };
    decode(ids: number[]): string;
  };
  dispose?: () => Promise<void>;
};

export class OnnxEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly modelId: string;
  /** Exact only after `load()`; the schema needs it before then. */
  dim: number;
  /** Reported ceiling — exact once `load()` has seen the model config. */
  maxSeqLength: number;
  readonly tokenizer: Tokenizer;

  private readonly dtype: string;
  /** The device asked for. What is actually in use is `activeDevice`. */
  private readonly device: string;
  /**
   * The execution provider actually in use, known only after `load()`.
   * `null` before then; `"cpu"` after a fallback. Reported by `GET /health`
   * so a user can see that their accelerator was not picked up, rather than
   * silently getting CPU speed and assuming otherwise.
   */
  activeDevice: string | null = null;
  private extractor: Extractor | null = null;
  private loading: Promise<void> | null = null;
  private readonly forcedMaxSeq: number | undefined;

  constructor(config: OnnxConfig) {
    this.modelId = config.model;
    this.model = `onnx:${config.model}`;
    this.dtype = config.dtype ?? "q8";
    this.device = config.device ?? "cpu";
    this.dim = 0; // unknown until the model reports hidden_size
    // Explicit override wins over everything; otherwise the known ceiling is a
    // pre-load estimate and the model config is authoritative once loaded.
    this.forcedMaxSeq = config.maxSeqLength;
    this.maxSeqLength = this.forcedMaxSeq ?? KNOWN_MAX_SEQ[config.model] ?? 512;

    const self = this;
    this.tokenizer = {
      countTokens(text) {
        return self._require().tokenizer.encode(text, { addSpecialTokens: false })
          .length;
      },
      sliceTokens(text, from, to) {
        const ids = self._require().tokenizer.encode(text, {
          addSpecialTokens: false,
        });
        return self._require().tokenizer.decode(Array.from(ids.slice(from, to)));
      },
    };
  }

  /** Whether `maxSeqLength` came from the model config rather than a fallback. */
  get seqLengthIsReported(): boolean {
    return this.forcedMaxSeq === undefined;
  }

  async load(): Promise<void> {
    if (this.extractor) return;
    this.loading ??= this._load();
    await this.loading;
  }

  private async _load(): Promise<void> {
    // Dynamic import: 775MB of transitive native deps must not be paid for by
    // tests and fake-provider users that never embed (ADR-019 isolation).
    const { pipeline, env } = await import("@huggingface/transformers");
    if (process.env.PRAG_TRANSFERS_OFFLINE === "1") {
      env.allowRemoteModels = false;
    }

    let extractor: Extractor;
    try {
      extractor = (await pipeline("feature-extraction", this.modelId, {
        dtype: this.dtype as "q8",
        device: this.device as "cpu",
      })) as unknown as Extractor;
      this.activeDevice = this.device;
    } catch (err) {
      // Graceful fallback to CPU: an accelerator that is configured but not
      // usable must not stop the daemon serving. It is logged rather than
      // swallowed, because silently running 10x slower than the user believes
      // is its own kind of failure.
      if (this.device === "cpu") throw err;
      console.error(
        `[prag] embedding device "${this.device}" failed to initialise, ` +
          `falling back to cpu: ${err instanceof Error ? err.message : String(err)}`,
      );
      extractor = (await pipeline("feature-extraction", this.modelId, {
        dtype: this.dtype as "q8",
        device: "cpu",
      })) as unknown as Extractor;
      this.activeDevice = "cpu";
    }

    const cfg = extractor.model?.config;
    if (cfg?.max_position_embeddings && this.forcedMaxSeq === undefined) {
      this.maxSeqLength = cfg.max_position_embeddings;
    }
    if (cfg?.hidden_size) this.dim = cfg.hidden_size;

    this.extractor = extractor;
  }

  private _require(): Extractor {
    if (!this.extractor) {
      throw new Error(
        `OnnxEmbeddingProvider(${this.modelId}) used before load()`,
      );
    }
    return this.extractor;
  }

  async embed(text: string): Promise<Float32Array> {
    const [v] = await this.embedBatch([text]);
    return v;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    await this.load();
    const out = await this._require()(texts, {
      pooling: "mean",
      normalize: true,
    });
    const [rows, cols] = out.dims.length === 1 ? [1, out.dims[0]] : out.dims;
    if (this.dim === 0) this.dim = cols;
    const result: Float32Array[] = [];
    for (let i = 0; i < rows; i++) {
      result.push(out.data.slice(i * cols, (i + 1) * cols));
    }
    return result;
  }

  async close(): Promise<void> {
    const ex = this.extractor;
    this.extractor = null;
    this.loading = null;
    await ex?.dispose?.();
  }
}

// ── Registration ──────────────────────────────────────────────────────

registerProvider("onnx:", (model) => {
  // PRAG_EMBEDDING_DEVICE is documented in env-and-storage-paths.md and was
  // read by nobody: the provider had a `device` option that nothing populated,
  // so every install silently ran on CPU whatever the user configured.
  const device = process.env.PRAG_EMBEDDING_DEVICE?.trim() || undefined;
  return new OnnxEmbeddingProvider({ model: model.slice("onnx:".length), device });
});
