Here is the architectural appendix for prag, capturing the complete lineage of technical implementations, frameworks, and database engines evaluated and systematically ruled out during this conversation.

Architectural Trade-offs & Ruled-Out Alternatives for prag


1. Vector Database Layer


Naive Text / JSON Files (Vectra)

• What it is: A lightweight, local file-based vector index for Node.js that saves state into flat text files.
• Why it was considered: Extremely low overhead, zero installation footprint, and simple to interface with directly in TypeScript.
• Why it was ruled out: Fell short on scaling, concurrent access, and branch-aware filtering. High file churn and rapid branch switches require constant mutations. Forcing Vectra to delete and update entries required scanning an index.json document payload line-by-line via JavaScript. Furthermore, applying branch scoping required fetching an excess of vector results and filtering them in-memory, introducing a massive CPU bottleneck.
• The prag Shift: Replaced by LanceDB, which natively supports transactional, column-oriented Apache Arrow data structures on disk, enabling true SQL-like scalar predicates (where branch = 'main') directly inside the native storage engine layer before scoring vector distances.

2. Ingestion & Document Chunking Layer


Fixed-Token / Naive Character Chunking (LangChain Standard Splitters)

• What it is: Slicing code files strictly by arbitrary token counts or character length rules (e.g., every 512 tokens).
• Why it was considered: The standard fallback method for general-purpose text processing pipelines.
• Why it was ruled out: Completely breaks source code semantics. Blindly slicing code fragments mid-sentence splits variables from their execution context or cuts logical scopes (like loops and functions) in half, heavily corrupting vector embedding accuracy.
• The prag Shift: Replaced by Tree-sitter node boundary parsing, which operates as a "smart ruler" to extract structurally whole, logically independent functional grammar blocks (function_definition, class_declaration).

Raw AST Token Vectorization

• What it is: Passing raw Abstract Syntax Tree (AST) structural token arrays directly to an embedding layer instead of text code blocks.
• Why it was considered: An attempt to capture purely mathematical syntax trees without relying on text naming variations.
• Why it was ruled out: Standard pre-trained transformer embedding models do not know how to interpret raw abstract token graphs out of the box. Pre-trained polyglot code models are trained on human-readable GitHub source code text, relying heavily on contextual patterns, formatting layout conventions, and descriptive function naming constraints.
• The prag Shift: Tree-sitter is strictly confined to identifying chunking borders. The extracted raw code string is what gets passed to the tokenizer of the local embedding model.

General-Purpose Agent Orchestration (LangChain)

• What it is: A popular framework for composing LLM chains and tools.
• Why it was considered: The default marketing recommendation for constructing RAG pipelines.
• Why it was ruled out: LangChain is engineered for high-level agent orchestration, tool use, and conversational memory, but features weak layout parsing defaults. Passing binary layout documents like PDFs or Word files results in naive string extraction that completely mangles multi-column structures, embedded tables, and footnotes.
• The prag Shift: Replaced by LlamaIndex (LlamaIndex.TS / @llamaindex/liteparse), which is engineered explicitly for structure-aware parsing, section hierarchy mapping, and native Apache Arrow vector store bindings.

3. Storage and Cache Management Strategy


Path-and-Branch Tracking Matrices

• What it is: Creating separate LanceDB tables or writing completely duplicate vector rows for every distinct file path across every distinct Git experiment branch.
• Why it was considered: A straightforward way to isolate file states across individual branches.
• Why it was ruled out: Creating separate database files wastes disk space and processing cycles. When a developer switches branches, duplicating vector calculations for files that haven't changed leads to high storage growth and unnecessary local GPU/CPU cycles.
• The prag Shift: Replaced by Content-Addressable Storage (CAS). The actual text code segments and vector embeddings are stored once in a global chunks_pool keyed by a deterministic file content hash (simulating a Git Blob SHA). Branch names are mapped to these hashes in a separate, lightweight file_mapping table. Switching branches only modifies pointers, bypassing deep learning inference pipelines entirely for unchanged files.

Pure Vector Indexes (No Local Content Retention)

• What it is: Storing only the generated float vectors and source file path pointers inside the database, reading the live file on disk whenever a result is fetched.
• Why it was considered: Reduces database disk space and limits potential local privacy footprints.
• Why it was ruled out: Causes major synchronization errors in environments with high file churn. If a developer edits a file or switches branches mid-task, the file state on disk immediately diverges from the version used to calculate the historical vector inside the database.
• The prag Shift: Storing the raw text chunk directly inside LanceDB alongside the vector arrays. Because it runs locally, this approach creates zero extra privacy risks while guaranteeing that search queries always return the exact code block that matches the semantic vector.

4. Execution Architecture


Isolated Short-Lived CLI Execution (Single Binary Mode)

• What it is: Bundling the file watcher, code parsers, embedding models, and search interface into a single script that initializes on every CLI command invocation.
• Why it was considered: Keeps deployment simple by removing the need for a persistent background service process.
• Why it was ruled out: Loading local ONNX deep learning models (even lightweight models like bge-small-en-v1.5) takes 200ms to 800ms to build tensor matrices and prime execution paths. Forcing this initialization step onto every simple terminal query breaks the snappy user experience developers expect.
• The prag Shift: Split into a dual-layered architecture. A persistent background daemon manages directory watchers, file processing queues, and model execution. The CLI tool connects read-only to LanceDB via fast memory-mapped file files (mmap), allowing it to boot instantly (<30ms) and query the index with minimal overhead.

High-Memory Multi-Lingual Processing (BAAI/bge-m3)

• What it is: Utilizing a large multi-lingual model capable of parsing across 100+ text and programming language spaces.
• Why it was considered: Exceptionally accurate semantic translation mappings across completely different code structures.
• Why it was ruled out: Too heavy to run as a local background utility on standard development workstations, leading to slow CPU inference speeds and high memory usage.
• The prag Shift: Replaced by compact polyglot-capable models like Xenova/bge-small-en-v1.5 or nomic-embed-text via Ollama. These models provide strong cross-language syntax mapping within a fast, low-memory footprint (~130MB on disk) that keeps the system lightweight and responsive.
Now that the technical decisions, architecture, and ruled-out alternatives are documented, let me know:
• Do you want to outline the Testing Suite Strategy (e.g., verifying cache hit ratios during simulated git checkouts)?
