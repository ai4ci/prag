// @prag/core — Embedding provider interface + fake deterministic provider
//
// ADR-019: fake:<dim> provider derives vectors deterministically from a hash
// of input text. Same text in, same vector out, every machine, every run.
// ADR-006: real providers (Ollama, ONNX) implement the same interface.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Tokenizer } from "./vector-units.js";

// ── Interface ─────────────────────────────────────────────────────────

export interface EmbeddingProvider {
  /** Provider identifier, e.g. "fake:384" or "ollama:nomic-embed-text". */
  readonly model: string;

  /** Vector dimension. */
  readonly dim: number;

  /** Maximum tokens this model accepts per input (for ADR-014 validation). */
  readonly maxSeqLength: number;

  /**
   * The model's tokenizer, when reachable locally. Used to size ADR-014
   * vectorised units; `undefined` means callers fall back to
   * `approximateTokenizer()`.
   */
  readonly tokenizer?: Tokenizer;

  /**
   * Embed a single text string. Returns a Float32Array of length `dim`.
   * Callers should chunk long text via vectorised units (ADR-014) before
   * calling this.
   */
  embed(text: string): Promise<Float32Array>;

  /**
   * Embed multiple texts in one batch (providers may optimise this).
   */
  embedBatch(texts: string[]): Promise<Float32Array[]>;

  /**
   * Load model weights. Optional for providers with no local weights.
   * `dim` and `maxSeqLength` are only trustworthy once this resolves, so a
   * caller that sizes vectors or ADR-014 windows must await it first.
   */
  load?(): Promise<void>;

  /** Release model weights / sessions. Optional for stateless providers. */
  close?(): Promise<void>;
}

// ── Sidecar descriptor (ADR-015) ──────────────────────────────────────

export interface EmbeddingSidecar {
  model: string;
  dim: number;
  maxSeqLength: number;
  /** ISO date when this sidecar was generated. */
  pinnedAt: string;
}

/** Read `<dir>/.embedding-model.json`, or null when absent/unreadable. */
export function readEmbeddingSidecar(dir: string): EmbeddingSidecar | null {
  try {
    const raw = readFileSync(join(dir, ".embedding-model.json"), "utf-8");
    return JSON.parse(raw) as EmbeddingSidecar;
  } catch {
    return null;
  }
}

/** Persist the sidecar describing the index's current embedding space. */
export function writeEmbeddingSidecar(
  dir: string,
  sidecar: EmbeddingSidecar,
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, ".embedding-model.json"),
    JSON.stringify(sidecar, null, 2) + "\n",
  );
}

// ── Fake provider (ADR-019) ───────────────────────────────────────────

const FAKE_DEFAULT_DIM = 384;
const FAKE_MAX_SEQ_LENGTH = 512;
const FAKE_SEED = 42;

/**
 * Deterministic fake embedding provider.
 *
 * Derives each vector dimension from a seeded hash of the input text.
 * Same text → same vector on every platform. No network, no filesystem,
 * no model load.
 *
 * **Not semantically meaningful.** Use only for plumbing assertions,
 * smoke-testing installs, and offline development.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dim: number;
  readonly maxSeqLength: number;

  constructor(dim: number = FAKE_DEFAULT_DIM) {
    this.model = `fake:${dim}`;
    this.dim = dim;
    this.maxSeqLength = FAKE_MAX_SEQ_LENGTH;
  }

  async embed(text: string): Promise<Float32Array> {
    return this._hashToVector(text);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this._hashToVector(t));
  }

  private _hashToVector(text: string): Float32Array {
    // Use SHA-256 seeded with the text to produce deterministic bytes.
    // Each dimension takes 4 bytes → need dim * 4 bytes.
    const hash = createHash("sha256").update(text).digest();

    // Extend hash to cover dim * 4 bytes using repeated HMAC-derived bytes.
    const vec = new Float32Array(this.dim);
    let seed = hash;
    let offset = 0;

    while (offset < this.dim) {
      // HMAC with current seed as key produces fresh bytes
      seed = createHash("sha256")
        .update(Buffer.from(FAKE_SEED.toString()))
        .update(seed)
        .digest();

      for (let i = 0; i < 8 && offset < this.dim; i++) {
        // Read 2 bytes from seed as a uint16, normalise to [-1, 1]
        const raw = seed.readUInt16LE(i * 2);
        vec[offset] = (raw / 65535) * 2 - 1;
        offset++;
      }
    }

    // L2-normalize so vectors are unit-length (matches real embedding output)
    const norm = Math.sqrt(
      Array.from(vec).reduce((sum, v) => sum + v * v, 0),
    );
    if (norm > 0) {
      for (let i = 0; i < this.dim; i++) {
        vec[i] /= norm;
      }
    }

    return vec;
  }
}

// ── Provider registry ─────────────────────────────────────────────────

export type ProviderFactory = (model: string) => EmbeddingProvider;

const registry = new Map<string, ProviderFactory>();

/**
 * Register a provider factory for a model prefix.
 * Built-in: `fake:` → FakeEmbeddingProvider.
 */
export function registerProvider(
  prefix: string,
  factory: ProviderFactory,
): void {
  registry.set(prefix, factory);
}

/**
 * Look up a provider by model string (e.g. "fake:384").
 *
 * The longest matching prefix wins, so a specific registration can override a
 * general one regardless of registration order — `registerProvider` is the
 * documented extension point, and a `onnx:Xenova/bge-small-en-v1.5` entry would
 * otherwise lose to the built-in `onnx:` factory.
 */
export function getProvider(model: string): EmbeddingProvider {
  let best: ProviderFactory | undefined;
  let bestLen = -1;
  for (const [prefix, factory] of registry) {
    if (model.startsWith(prefix) && prefix.length > bestLen) {
      best = factory;
      bestLen = prefix.length;
    }
  }
  if (!best) {
    throw new Error(
      `No embedding provider registered for model "${model}". ` +
        `Available prefixes: ${[...registry.keys()].join(", ")}`,
    );
  }
  return best(model);
}

// ── Default model ─────────────────────────────────────────────────

/** The model prag embeds with when nothing is configured (ADR-006). */
export const DEFAULT_EMBEDDING_MODEL = "onnx:Xenova/bge-small-en-v1.5";

/**
 * Resolve a model string to a provider. Accepts the registry prefixes
 * (`fake:384`, `ollama:nomic-embed-text`, `onnx:Xenova/…`) and a bare ONNX id
 * (`Xenova/bge-small-en-v1.5`), which is how model ids are normally written.
 */
export function resolveEmbeddingModel(model: string): EmbeddingProvider {
  const key = /^[a-z]+:/.test(model) ? model : `onnx:${model}`;
  return getProvider(key);
}

/** Parse dim from "fake:<dim>". */
export function parseFakeDim(model: string): number {
  const m = /^fake[:_](\d+)$/.exec(model);
  if (!m) throw new Error(`Invalid fake model string "${model}"`);
  return parseInt(m[1], 10);
}

// ── Init ──────────────────────────────────────────────────────────────

registerProvider("fake:", (model) => {
  const dim = parseFakeDim(model);
  return new FakeEmbeddingProvider(dim);
});
