export {
  evaluateUriGrants,
  type GrantAction,
  type GrantReason,
  type ProjectStatus,
  type GrantRow,
  type ProjectRow,
  type BranchMappingRow,
  type FileMappingRow,
  type ChunkMappingRow,
  type ChunksPoolRow,
  type VectorPoolRow,
  type SearchQueryOptions,
  type SearchHit,
  type GrantEvaluation,
} from "./schema.js";

export {
  LanceDbSchema,
  API_VERSION,
  ALL_TABLES,
  upsertGrants,
  upsertProjects,
  upsertBranchMapping,
  upsertFileMapping,
  upsertChunkMapping,
  upsertChunksPool,
  upsertVectorPool,
  type DatabaseConfig,
  type TableDefinition,
} from "./database.js";

export {
  hybridSearch,
  type SearchResult,
  type SearchFileHit,
  type SearchChunkHit,
} from "./search.js";

export {
  FakeEmbeddingProvider,
  getProvider,
  registerProvider,
  parseFakeDim,
  type EmbeddingProvider,
  type EmbeddingSidecar,
  type ProviderFactory,
} from "./embedding.js";

export {
  OllamaEmbeddingProvider,
  type OllamaConfig,
} from "./ollama-provider.js";

export {
  chunkFile,
  chunkHash,
  normalizeWhitespace,
  detectLanguageFromPath,
  type Chunk,
  type ChunkedFile,
} from "./chunker.js";

export {
  resolvePragPaths,
  loadPragConfig,
  type PragPaths,
  type PragConfig,
} from "./paths.js";

