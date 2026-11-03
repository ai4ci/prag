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
  CONTENT_TABLES,
  schemaDiff,
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
  EXIT,
  EXIT_FOR_CODE,
  HTTP_STATUS_FOR_CODE,
  exitForCode,
  DaemonFailure,
  type ErrorCode,
  type ClientErrorCode,
  type FailureCode,
  type ErrorEnvelope,
  type ExitCode,
} from "./errors.js";

export {
  discoveryDryRun,
  isDenied,
  isBuiltinIgnored,
  probeFile,
  grantPatternToPath,
  pathToGrantPattern,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_WATCH_CONFIRM_THRESHOLD,
  BUILTIN_IGNORED_BASENAMES,
  type DiscoveryLimits,
  type DryRunResult,
  type SkipReason,
} from "./discovery.js";

export {
  hybridSearch,
  type SearchResult,
  type SearchFileHit,
  type SearchChunkHit,
  type SearchMode,
  type HybridSearchOptions,
} from "./search.js";

export {
  resolveBranch,
  isGitWorkspace,
  listGitBranches,
  DEFAULT_BRANCH,
} from "./branch.js";

export {
  FakeEmbeddingProvider,
  getProvider,
  registerProvider,
  resolveEmbeddingModel,
  parseFakeDim,
  readEmbeddingSidecar,
  writeEmbeddingSidecar,
  DEFAULT_EMBEDDING_MODEL,
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
  UNSUPPORTED_DOCUMENT_EXTENSIONS,
  type Chunk,
  type ChunkedFile,
} from "./chunker.js";

export {
  OnnxEmbeddingProvider,
  type OnnxConfig,
} from "./onnx-provider.js";

export {
  splitVectorUnits,
  assertVectorUnitBudget,
  approximateTokenizer,
  DEFAULT_MAX_VECTOR_UNIT_TOKENS,
  DEFAULT_VECTOR_UNIT_OVERLAP_TOKENS,
  type Tokenizer,
} from "./vector-units.js";

export {
  chunkMarkdown,
  chunkDocumentOrCode,
} from "./markdown-chunker.js";

export {
  resolvePragPaths,
  ensurePragDirs,
  loadPragConfig,
  type PragPaths,
  type PragConfig,
} from "./paths.js";


// ADR-024: web fetch backends. Importing plain-fetcher registers the
// zero-configuration built-in, so `web.backend: "plain-fetcher"` resolves
// without the caller wiring anything up.
export {
  registerWebBackend,
  resolveWebBackend,
  availableWebBackends,
  requireCapability,
  type WebFetchBackend,
  type WebCapability,
  type WebFetchResult,
  type WebDiscoverResult,
  type WebSearchResult,
  type WebBackendConfig,
  type FreshnessHint,
} from "./web-backend.js";
export { PLAIN_FETCHER_ID, htmlToText } from "./plain-fetcher.js";

// ADR-003: which binary formats have a document parser. The policy is here so
// discovery, admission and the worker cannot disagree; the parsers are in
// @prag/daemon.
export {
  DOCUMENT_FORMATS,
  documentCategory,
  DEFAULT_MAX_DOCUMENT_BYTES,
  DEFAULT_MAX_DOCUMENT_PAGES,
} from "./document-formats.js";
