// @prag/core — ADR-014 vectorised units
//
// A **chunk** is one whole structural unit and is never split. A **vectorised
// unit** is a sliding token window over one chunk, sized to fit the active
// embedding model. This module turns a chunk into 1..* unit strings ready to
// embed; `chunkHash` and `chunks_pool` are untouched by any of it.

// ── Tokenizer interface ───────────────────────────────────────────────

/**
 * Minimal tokenizer contract for window sizing. The real implementation is the
 * active embedding model's own tokenizer (`OnnxEmbeddingProvider` implements
 * this); `approximateTokenizer` is the fallback for providers that do not
 * expose one (Ollama serves a model we cannot tokenise locally).
 */
export interface Tokenizer {
  countTokens(text: string): number;
  /**
   * Decode the token window `[from, to)` back to text. Must be cheap enough to
   * call once per unit.
   */
  sliceTokens(text: string, from: number, to: number): string;
}

// ── Defaults (ADR-014 clause 2) ───────────────────────────────────────

export const DEFAULT_MAX_VECTOR_UNIT_TOKENS = 400;
export const DEFAULT_VECTOR_UNIT_OVERLAP_TOKENS = 60;

// ── Approximate tokenizer ─────────────────────────────────────────────

/**
 * Whitespace/punctuation tokenizer used when the provider cannot tokenise.
 * Word-ish runs and each run of punctuation are one token each, which is close
 * to WordPiece for code (measured within ~15% on TS/Python sources) — so window
 * sizing stays conservative rather than silently overflowing the model.
 *
 * shortcut: approximate; upgrade by passing the model's real Tokenizer.
 */
export function approximateTokenizer(): Tokenizer {
  const tokenize = (text: string): string[] => text.match(/\w+|[^\s\w]/g) ?? [];
  return {
    countTokens: (text) => tokenize(text).length,
    sliceTokens: (text, from, to) => tokenize(text).slice(from, to).join(" "),
  };
}

// ── Splitting ─────────────────────────────────────────────────────────

/**
 * Split one chunk into vectorised units.
 *
 * Returns exactly one unit when the chunk (plus its scope prefix) already fits
 * under `maxTokens`. Otherwise returns sliding windows advancing by
 * `maxTokens - overlapTokens`, so no token range is dropped.
 *
 * `prefix` is the chunk's enclosing-scope annotation (ADR-014 clause 5). It is
 * counted against the budget of every unit and is never stored — the caller
 * embeds the returned strings and keeps `chunks_pool.text` as the whole chunk.
 *
 * Each returned string is `prefix + "\n" + window` (prefix omitted when empty).
 */
export function splitVectorUnits(
  text: string,
  prefix: string,
  tokenizer: Tokenizer,
  maxTokens: number = DEFAULT_MAX_VECTOR_UNIT_TOKENS,
  overlapTokens: number = DEFAULT_VECTOR_UNIT_OVERLAP_TOKENS,
): string[] {
  if (maxTokens <= 0) {
    throw new Error(`maxTokens must be > 0, got ${maxTokens}`);
  }
  if (overlapTokens < 0 || overlapTokens >= maxTokens) {
    throw new Error(
      `overlapTokens must be in [0, maxTokens), got ${overlapTokens} for maxTokens=${maxTokens}`,
    );
  }

  const prefixTokens = prefix ? tokenizer.countTokens(prefix) : 0;
  const budget = maxTokens - prefixTokens;
  if (budget <= 0) {
    // A scope annotation longer than the model's window is a config error, not
    // something to paper over by dropping the prefix.
    throw new Error(
      `scope prefix (${prefixTokens} tokens) leaves no room under maxTokens=${maxTokens}`,
    );
  }

  const bodyTokens = tokenizer.countTokens(text);
  const join = (window: string) => (prefix ? `${prefix}\n${window}` : window);

  // Whole-chunk case: return the text verbatim. Round-tripping through the
  // tokenizer here would reformat code that never needed splitting at all.
  if (bodyTokens <= budget) {
    return [join(text)];
  }

  const stride = Math.max(1, budget - overlapTokens);
  const units: string[] = [];
  for (let start = 0; start < bodyTokens; start += stride) {
    units.push(join(tokenizer.sliceTokens(text, start, start + budget)));
    if (start + budget >= bodyTokens) break;
  }
  return units;
}

/**
 * ADR-014 clause 3: refuse to start when the configured window cannot fit in
 * the model's reported ceiling. Kept separate from LanceDbSchema.validate() so
 * the daemon can check before loading any model weights.
 */
export function assertVectorUnitBudget(
  maxVectorUnitTokens: number,
  modelMaxSeqLength: number,
): void {
  if (maxVectorUnitTokens > modelMaxSeqLength) {
    throw new Error(
      `embedding.maxVectorUnitTokens (${maxVectorUnitTokens}) exceeds the active ` +
        `model's reported maximum sequence length (${modelMaxSeqLength}). ` +
        `Refusing to start (ADR-014).`,
    );
  }
}
