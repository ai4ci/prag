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
  uri: string;
  language: string;
  contentHash: string;
  score: number;
  chunks: SearchChunkHit[];
}

export interface SearchResult {
  query: string;
  hits: SearchFileHit[];
  totalChunks: number;
}

// ── RRF Constants ──────────────────────────────────────────────────────

const RRF_K = 60;

// ── Hybrid search ─────────────────────────────────────────────────────

/**
 * Run hybrid search across FTS and vector indexes, fuse via RRF, and
 * map results back to files through the mapping tables.
 *
 * @param chunksTable  - The chunks_pool table (must have FTS index on "text").
 * @param vectorsTable - The vector_pool table (must have IVF_PQ index on "vector").
 * @param chunkMapping - The chunk_mapping table.
 * @param fileMapping  - The file_mapping table.
 * @param embedder     - Embedding provider for vector search.
 * @param query        - User query string.
 * @param limit        - Max file-level results (default 10).
 * @param ftsLimit     - Max FTS results to fetch for fusion (default 50).
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
): Promise<SearchResult> {
  // Run both searches in parallel
  const [ftsHits, vectorHits] = await Promise.all([
    ftsSearch(chunksTable, query, ftsLimit),
    vectorSearch(vectorsTable, chunksTable, embedder, query, ftsLimit),
  ]);

  // Fuse via RRF
  const fused = fuseResults(ftsHits, vectorHits);

  // Map to files
  const fileHits = await mapToFiles(
    fused,
    chunkMapping,
    fileMapping,
    limit,
  );

  return {
    query,
    hits: fileHits,
    totalChunks: fused.length,
  };
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
  embedder: EmbeddingProvider,
  query: string,
  limit: number,
): Promise<SearchChunkHit[]> {
  // Embed the query
  const qvec = await embedder.embed(query);

  // Search vector_pool
  const vecResults = await vectorsTable
    .query()
    .nearestTo(qvec)
    .limit(limit)
    .toArray();

  // Collect unique chunkHashes (same chunk may have multiple units)
  const seen = new Set<string>();
  const chunkResults: Array<{ chunkHash: string; distance: number }> = [];

  for (const r of vecResults as Array<Record<string, unknown>>) {
    const hash = r.chunkHash as string;
    const dist = (r._distance as number) ?? 1;
    if (!seen.has(hash)) {
      seen.add(hash);
      chunkResults.push({ chunkHash: hash, distance: dist });
    }
  }

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

  // Lookup file info
  const fvids = [...fileChunks.keys()];
  const fileRows = await fileMapping
    .query()
    .where(
      `fileVersionId IN (${fvids.map((id) => `'${id}'`).join(",")})`,
    )
    .limit(fvids.length)
    .toArray();

  const fileInfo = new Map<
    string,
    { uri: string; language: string; contentHash: string }
  >();
  for (const row of fileRows as Array<Record<string, unknown>>) {
    fileInfo.set(row.fileVersionId as string, {
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
