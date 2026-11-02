// @prag/core — Hybrid search: FTS + vector with RRF fusion
//
// Searches chunks_pool with FTS (BM25) and vector_pool with cosine distance,
// then fuses results via Reciprocal Rank Fusion and maps back to files.

import { type Table } from "@lancedb/lancedb";
import { type EmbeddingProvider } from "./embedding.js";

// ── Types ─────────────────────────────────────────────────────────────

export interface SearchChunkHit {
  chunkHash: string;
  text: string;
  scopeContext: string | null;
  score: number;
  source: "fts" | "vector";
}

export interface SearchFileHit {
  fileVersionId: string;
  projectId: string;
  uri: string;
  language: string;
  contentHash: string;
  score: number;
  chunks: SearchChunkHit[];
}

export type SearchMode = "hybrid" | "vector" | "fts";

export interface SearchResult {
  query: string;
  mode: SearchMode;
  hits: SearchFileHit[];
  totalChunks: number;
}

export interface HybridSearchOptions {
  /** Restrict results to one project's files. Omitted = every project. */
  projectId?: string;
  limit?: number;
  /** Candidate pool per source before fusion (default 50). */
  candidateLimit?: number;
  mode?: SearchMode;
}

// ── RRF Constants ──────────────────────────────────────────────────────

const RRF_K = 60;

// ── Hybrid search ─────────────────────────────────────────────────────

/**
 * Run hybrid search across FTS and vector indexes, fuse via RRF, and
 * map results back to files through the mapping tables.
 *
 * Project scoping (`options.projectId`) is applied before the file-level limit
 * is taken, so a scoped query returns `limit` in-scope files rather than
 * whatever survived filtering.
 *
 * @param chunksTable  - The chunks_pool table (must have FTS index on "text").
 * @param vectorsTable - The vector_pool table (must have IVF_PQ index on "vector").
 * @param chunkMapping - The chunk_mapping table.
 * @param fileMapping  - The file_mapping table.
 * @param embedder     - Embedding provider for vector search.
 * @param query        - User query string.
 * @param limit        - Max file-level results (default 10).
 * @param ftsLimit     - Max candidates to fetch per source for fusion (default 50).
 */
export async function hybridSearch(
  chunksTable: Table,
  vectorsTable: Table,
  chunkMapping: Table,
  fileMapping: Table,
  embedder: EmbeddingProvider,
  query: string,
  limit: number = 10,
  ftsLimit: number = 50,
  options: HybridSearchOptions = {},
): Promise<SearchResult> {
  const mode = options.mode ?? "hybrid";
  const pool = options.candidateLimit ?? ftsLimit;
  const projectId = options.projectId;

  // The query vector is computed once and reused across widening passes.
  const queryVector =
    mode === "fts" ? null : await embedder.embed(query);

  // Candidate pool per source. With no scope, one pass is exact. With a scope,
  // in-scope chunks can sit below the pool cut-off, so widen until the limit is
  // satisfied or a pass stops growing the pool.
  let size = pool;
  for (;;) {
    const [ftsHits, vectorHits] = await Promise.all([
      mode === "vector" ? [] : ftsSearch(chunksTable, query, size),
      queryVector
        ? vectorSearch(vectorsTable, chunksTable, queryVector, size)
        : [],
    ]);

    const fused = fuseResults(ftsHits, vectorHits);
    const fileHits = await mapToFiles(
      fused,
      chunkMapping,
      fileMapping,
      limit,
      projectId,
    );

    if (fileHits.length >= limit || !projectId || fused.length < size) {
      return { query, mode, hits: fileHits, totalChunks: fused.length };
    }
    size *= 4;
  }
}

// ── FTS search ────────────────────────────────────────────────────────

async function ftsSearch(
  table: Table,
  query: string,
  limit: number,
): Promise<SearchChunkHit[]> {
  const results = await table
    .query()
    .nearestToText(query)
    .limit(limit)
    .toArray();

  return results.map((r: Record<string, unknown>, i: number) => ({
    chunkHash: r.chunkHash as string,
    text: r.text as string,
    scopeContext: (r.scopeContext as string) ?? null,
    score: r._score != null ? (r._score as number) : 1 / (i + 1),
    source: "fts" as const,
  }));
}

// ── Vector search ─────────────────────────────────────────────────────

async function vectorSearch(
  vectorsTable: Table,
  chunksTable: Table,
  queryVector: Float32Array,
  limit: number,
): Promise<SearchChunkHit[]> {
  // Search vector_pool
  const vecResults = await vectorsTable
    .query()
    .nearestTo(queryVector)
    .limit(limit)
    .toArray();

  // Collapse units: one chunk may contribute several overlapping windows, and
  // only its best (smallest-distance) unit represents it.
  const best = new Map<string, number>();
  for (const r of vecResults as Array<Record<string, unknown>>) {
    const hash = r.chunkHash as string;
    const dist = (r._distance as number) ?? 1;
    const seen = best.get(hash);
    if (seen === undefined || dist < seen) best.set(hash, dist);
  }
  const chunkResults = [...best].map(([chunkHash, distance]) => ({
    chunkHash,
    distance,
  }));

  // Fetch text for each chunk from chunks_pool
  const textMap = new Map<string, string>();
  const scopeMap = new Map<string, string | null>();

  for (const cr of chunkResults) {
    const row = await chunksTable
      .query()
      .where(`chunkHash = '${cr.chunkHash}'`)
      .limit(1)
      .toArray();
    if (row.length > 0) {
      textMap.set(cr.chunkHash, (row[0] as Record<string, unknown>).text as string);
      scopeMap.set(
        cr.chunkHash,
        ((row[0] as Record<string, unknown>).scopeContext as string) ?? null,
      );
    }
  }

  return chunkResults.map((cr, i) => ({
    chunkHash: cr.chunkHash,
    text: textMap.get(cr.chunkHash) ?? "",
    scopeContext: scopeMap.get(cr.chunkHash) ?? null,
    // Convert distance to a score where smaller distance = higher score
    score: cr.distance > 0 ? 1 / (cr.distance + 0.001) : 1000,
    source: "vector" as const,
  }));
}

// ── RRF fusion ────────────────────────────────────────────────────────

function fuseResults(
  fts: SearchChunkHit[],
  vector: SearchChunkHit[],
): SearchChunkHit[] {
  // Build rank maps: chunkHash → rank (1-based)
  const ftsRank = new Map<string, number>();
  const vecRank = new Map<string, number>();

  fts.forEach((h, i) => ftsRank.set(h.chunkHash, i + 1));
  vector.forEach((h, i) => vecRank.set(h.chunkHash, i + 1));

  // Collect all unique chunk hashes
  const allHashes = new Set([
    ...ftsRank.keys(),
    ...vecRank.keys(),
  ]);

  // Compute RRF score for each chunk
  const scored = [...allHashes].map((hash) => {
    const fr = ftsRank.get(hash) ?? Infinity;
    const vr = vecRank.get(hash) ?? Infinity;
    const rrfScore =
      (fr !== Infinity ? 1 / (RRF_K + fr) : 0) +
      (vr !== Infinity ? 1 / (RRF_K + vr) : 0);

    // Pick the best source hit for metadata
    const ftsHit = fts.find((h) => h.chunkHash === hash);
    const vecHit = vector.find((h) => h.chunkHash === hash);
    const best = ftsHit ?? vecHit!;

    return { ...best, score: rrfScore };
  });

  // Sort by RRF score descending
  return scored.sort((a, b) => b.score - a.score);
}

// ── File mapping ──────────────────────────────────────────────────────

async function mapToFiles(
  chunks: SearchChunkHit[],
  chunkMapping: Table,
  fileMapping: Table,
  limit: number,
  projectId?: string,
): Promise<SearchFileHit[]> {
  if (chunks.length === 0) return [];

  // Batch lookup: get fileVersionId for each chunkHash
  const chunkHashes = chunks.map((c) => c.chunkHash);
  const chunkRows = await chunkMapping
    .query()
    .where(
      `chunkHash IN (${chunkHashes.map((h) => `'${h}'`).join(",")})`,
    )
    .limit(chunkHashes.length)
    .toArray();

  // Group chunks by fileVersionId
  const fileChunks = new Map<string, SearchChunkHit[]>();
  for (const row of chunkRows as Array<Record<string, unknown>>) {
    const fvid = row.fileVersionId as string;
    const ch = row.chunkHash as string;
    const chunk = chunks.find((c) => c.chunkHash === ch);
    if (chunk) {
      if (!fileChunks.has(fvid)) fileChunks.set(fvid, []);
      fileChunks.get(fvid)!.push(chunk);
    }
  }

  if (fileChunks.size === 0) return [];

  // Lookup file info, scoped to one project when asked. The scope predicate
  // belongs here (not on the ANN/FTS query) because chunks_pool and vector_pool
  // are global by design — project membership lives in file_mapping.
  const fvids = [...fileChunks.keys()];
  const scope = projectId
    ? ` AND projectId = '${projectId.replace(/'/g, "''")}'`
    : "";
  const fileRows = await fileMapping
    .query()
    .where(
      `fileVersionId IN (${fvids.map((id) => `'${id}'`).join(",")})${scope}`,
    )
    .limit(fvids.length)
    .toArray();

  const fileInfo = new Map<
    string,
    { projectId: string; uri: string; language: string; contentHash: string }
  >();
  for (const row of fileRows as Array<Record<string, unknown>>) {
    fileInfo.set(row.fileVersionId as string, {
      projectId: row.projectId as string,
      uri: row.uri as string,
      language: row.language as string,
      contentHash: row.contentHash as string,
    });
  }

  // Build results sorted by best chunk score per file
  const results: SearchFileHit[] = [];
  for (const [fvid, chks] of fileChunks) {
    const info = fileInfo.get(fvid);
    if (!info) continue;
    const bestScore = Math.max(...chks.map((c) => c.score));
    chks.sort((a, b) => b.score - a.score);
    results.push({
      fileVersionId: fvid,
      ...info,
      score: bestScore,
      chunks: chks,
    });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}
