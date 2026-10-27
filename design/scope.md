
Production Specification: Polyglot Local Code & Documentation Semantic Search Indexer

This document establishes the unified requirements, Architectural Decision Records (ADRs), and interface specifications for a localized, highly scalable, eventually consistent semantic indexing system. It provides a complete blueprint for an implementation project without code logic.

1. System Requirements


1.1 Ingestion & Parsing

• Multi-Format Processing: The system must process structured programming source code files (.ts, .js, .py, .r, etc.), prose markdown (.md, .txt), and rich text/binary layout documents (.pdf, .docx).
• Syntax-Aware Code Chunking: Source code must be partitioned along structural semantic boundaries (e.g., classes, functions, methods) utilizing grammar definitions to preserve contextual integrity.
• Layout-Preserving Document Chunking: Binary documentation layouts (such as PDFs) must be decomposed offline while preserving tables, lists, headers, and relative section hierarchy.
• Multi-Project Multi-Tenant Isolation: The engine must independently manage distinct target folder workspaces (e.g., software repositories or personal Obsidian knowledge bases), assigning static scopes to prevent cross-contamination unless explicitly requested during runtime querying.

1.2 Eventual Consistency & Churn Resiliency

• Non-Blocking Background Worker Queue: File-system changes (file mutations, additions, or deletions) must be captured asynchronously, pushed into a thread-safe processing structure, and debounced to ensure layout compilation triggers only after disk writes settle.
• Git Branch Awareness: The indexing workspace must map file metrics against the active Git working branch.
• State Continuity Over Churn: When switching branches (git checkout), data modifications must be safely partitioned. Unchanged files shared across branches must be tracked efficiently to bypass computational overhead.

1.3 Execution Constraints & Interface Layer

• 100% Air-Gapped/Local Runtime: No source text, layout data, structural metadata, or generated embedding float vectors may leave the physical machine runtime perimeter.
• Hardware-Configurable Acceleration: The system must support configurable local acceleration execution providers (e.g., GPU/CUDA/WebGPU processing for swift local inference), falling back gracefully to optimized CPU loops when dedicated hardware is missing.
• Dual Interface Presentation: The stored data must be queryable via a short-lived, low-latency Command Line Interface (CLI) and natively exposed as a Model Context Protocol (MCP) server listening over local host channels (stdio or Server-Sent Events).

2. Architectural Decision Records (ADRs)


ADR-001: Storage Engine Selection (LanceDB Core Matrix)

• Context: The engine must support rapid, eventually consistent updates under high file churn, branch isolation, and multi-project filtering requirements without running heavy background server daemons.
• Decision: We select LanceDB as the unified data storage engine.
• Consequence: LanceDB operates serverless via zero-copy memory-mapped file operations (mmap), allowing the short-lived CLI tool to boot instantly (<30ms) and interact read-only with database tables. Crucially, it provides native SQL-like scalar predicates, enabling the execution layer to filter out branch constraints (where branch = 'feature') before executing vector arithmetic.

ADR-002: Content-Addressable Storage (CAS) for Git Branch Proliferation

• Context: Blindly duplicating vector calculations on file modifications or branch switching leads to index corruption, high CPU usage, and bloated storage metrics.
• Decision: Implement Content-Addressable Storage utilizing deterministic hashing mechanisms (e.g., Content SHA-1 keys) to decouple raw text blocks from active working branches.
• Consequence: Storage splits into two functional datasets: a global chunks_pool (holding text, hashes, and vectors) and a relational file_mapping dataset (connecting paths and branches to hashes). If a file remains identical across multiple branches, it is calculated and written exactly once. Git checkouts trigger minor pointer movements rather than expensive deep learning pipeline runs.

ADR-003: Selection of Parsing Frameworks

• Context: Unified multi-language support (including data science layouts like R) requires robust AST tree mapping, while document layout mapping requires layout awareness.
• Decision: Standardize on Tree-sitter (via automated multi-language wrapper registries: tree-sitter-language-pack) for programming files and LiteParse for localized binary layouts (PDF/Word).
• Tree-sitter used for content dependent chunking and code chunk context management.
• Consequence: Avoids manual tree walking logic across different languages by outsourcing grammar node configurations to an auto-downloading engine runtime. LiteParse converts rich text directly into cleanly structured local Markdown strings.

ADR-004: In-Database Local Content Retention

• Context: Storing only float vectors and reference paths saves database space but introduces breaking sync issues if an IDE updates a file or changes branches before a query runs.
• Decision: Store the raw text segment content inside the local database alongside the vector arrays.
• Consequence: Because data stays fully local, retaining the text string preserves search speed and query execution reliability without adding privacy concerns. The system can immediately show matching code or documentation blocks, even if the user's workspace is mid-refactor.

3. Interface & Schema Specifications

                     ┌────────────────────────┐
                     │   CLI / MCP Client     │
                     └───────────┬────────────┘
                                 │
                 Unified Schema  │  (Branch/Project Filters)
                 SQL Queries     ▼
                     ┌────────────────────────┐
                     │   LanceDB Columnar     │
                     └───────────▲────────────┘
                                 │
                   Batch Payload │  (Hashed Vector Outputs)
                   Transactions  │
                     ┌───────────┴────────────┐
                     │  Background Daemon     │
                     └────────────────────────┘

3.1 Database Schema Definition


Table: chunks_pool

Represents the de-duplicated data pool of vector embeddings and structural code strings.

Field Name	Data Type	Constraints / Attributes	Description
id	String	Primary Key, Deterministic	Format: ${contentHash}::${chunkIndex}
contentHash	String	Indexed, Fixed Length	Deterministic SHA-1 signature of the complete parent source file content.
text	String	Non-Null	The raw text code slice or layout paragraph block.
vector	Float32 Array	Dimensions determined by model	Dense embedding representation generated by the configured polyglot model.


Table: file_mapping

Maps active workspace pathways and branch configurations to underlying storage block hashes.

Field Name	Data Type	Constraints / Attributes	Description
projectId	String	Indexed	Unique identifier slug assigned to the project folder workspace.
filePath	String	Indexed	Absolute pathing marker identifying the resource location on disk.
branch	String	Indexed	Active working branch context or virtual baseline label (e.g., production).
contentHash	String	Foreign Reference	Points to the matching signature within the chunks_pool storage matrix.
language	String	None	Detected asset category (e.g., typescript, r, markdown, pdf).


3.2 Daemon Control Interface Specs

The Core Background Process exposes the following programmatic contracts for managing directory inputs and file-system changes:
typescript
export interface IngestionQueueItem {
  projectId: string;
  absolutePath: string;
  eventType: 'add' | 'change' | 'unlink';
}

export interface ProjectWorkspaceConfig {
  id: string;
  rootPath: string;
  isGit: boolean;
  filePatterns?: string[]; // Glob filters to track or ignore
}

export interface IBackgroundIndexerDaemon {
  /**
   * Initializes the persistent database connection layers and primes model execution parameters.
   * Logs available hardware acceleration providers (e.g., CUDA, WebGPU, CPU).
   */
  initialize(modelName: string, options: { preferGPU: boolean }): Promise<void>;

  /**
   * Dynamically attaches a project folder workspace to the background filesystem monitoring loops.
   */
  registerProject(config: ProjectWorkspaceConfig): Promise<void>;

  /**
   * Schedules a file modification event to process through the thread-safe background queue.
   */
  enqueueFileEvent(item: IngestionQueueItem): void;
}
Use code with caution.

3.3 Query Interface Specs

To ensure clean communication between the background worker loop and consumption clients (like the CLI or an AI environment), search methods must expose the following interface parameters:
typescript
export interface SearchQueryOptions {
  query: string;           // Natural language search query
  activeBranch: string;    // Target branch context to enforce
  scopeProjectId?: string; // Restricts search to a single project workspace if specified
  limit?: number;          // Maximum number of distinct matches to return
}

export interface SearchHitResult {
  score: number;           // Calculated mathematical similarity distance metric
  projectId: string;       // Originating workspace identifier
  relativePath: string;    // Clean local file path position relative to project root
  language: string;        // Code grammar identity or layout signature
  text: string;            // The raw matched code string or layout text segment
}

export interface ISearchEngine {
  /**
   * Interrogates LanceDB storage tables using pre-filtering SQL constraints to return 
   * semantic similarities across workspace domains.
   */
  executeSearch(options: SearchQueryOptions): Promise<SearchHitResult[]>;
}
Use code with caution.

3.4 Model Context Protocol (MCP) Tool Contract

The system must wrap the search query engine inside a compliant Stdio Model Context Protocol handler, advertising the following schema to external AI layers:

Tool Protocol Identity

• Name: semantic_repository_search
• Description: Executes localized semantic vector matching operations against tracked directories for code chunks, markdown repositories, and document layouts.

JSON Input Parameters Schema

json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "The natural language query string describing the logic, function, or document section you want to find."
    },
    "branch": {
      "type": "string",
      "description": "Active working branch context matching current workspace repository checkout coordinates.",
      "default": "main"
    },
    "projectId": {
      "type": "string",
      "description": "Optional unique project workspace slug identifier used to constrain vector bounds."
    },
    "limit": {
      "type": "integer",
      "description": "Maximum number of distinct context paragraphs or code slices to fetch.",
      "default": 3
    }
  },
  "required": ["query"]
}

