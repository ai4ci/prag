# prag 🚀

`prag` (**Pragmatic RAG) is a fast, 100% local, air-gapped semantic search and RAG indexing engine for mixed codebases and documentation repositories. It is built specifically to handle high file churn, understand Git branches natively, and run completely within your local workstation's hardware perimeter.

It utilizes **Tree-sitter** for syntax-aware code parsing, **@llamaindex/liteparse** for layout-aware document extraction, and **LanceDB** for embedded, column-oriented vector storage.

---

## 🛠 Architectural Overview

`prag` splits responsibilities into a dual-component architecture inside a single unified TypeScript monorepo:

1. **The Background Daemon (`@prag/daemon`):** A long-running service that watches registered workspace directories, orchestrates an asynchronous ingestion queue, parses files via AST/Markdown frameworks, runs local ONNX embedding models (with hardware-configured GPU acceleration), and updates storage.
2. **The Read-Only CLI Tool (`@prag/cli`):** A lightweight, instantly booting terminal binary that bypasses heavy model initialization by reading directly from LanceDB’s memory-mapped files (`mmap`) using fast pre-filtering SQL constraints. It is also exposed as a standardized **Model Context Protocol (MCP)** server for IDE integrations (e.g., Cursor, Claude Desktop).

---

## 📦 Monorepo Layout

```text
prag/
├── packages/
│   ├── core/         # Shared schemas, database connection utilities, and TS interfaces
│   ├── daemon/       # Background file watcher (Chokidar), Tree-sitter + LiteParse routing, and MCP Server
│   └── cli/          # High-performance, read-only terminal search client binary
```

---

## ⚡ Core Architectural Decisions (ADRs)

* **Content-Addressable Storage (CAS):** File contents are parsed and embedded *exactly once* based on their unique cryptographic hash. Git checkouts or branches sharing identical code blocks consume zero extra CPU/GPU cycles and zero duplicate disk footprint.
* **Pre-Filtering Matrix Layer:** Branch-awareness is enforced via LanceDB's fast scalar predicates. Filtering out irrelevant branches is executed at the native disk layout layer *before* scoring vector distances.
* **Local Content Retention:** Raw text segments are cached directly inside LanceDB (`chunks_pool`) alongside their embeddings (`vector_pool`), making query retrieval resilient against uncommitted edits and rapid workspace branch hopping.
* **Chunks vs Vectorised Units:** A chunk is one whole structural unit and is always returned whole. When a chunk is too large for the embedding model, it is embedded as several overlapping windows under one hash rather than being split (see ADR-014).

---

## 🚦 Roadmap & Work in Progress

### Phase 1: Storage & Shared Core (Current WIP)
- [ ] Define shared TypeScript database model definitions (`@prag/core`).
- [ ] Implement LanceDB initialization scripts for the 7-table schema (`grants`, `projects`, `branch_mapping`, `file_mapping`, `chunk_mapping`, `chunks_pool`, `vector_pool`).

### Phase 2: Ingestion & Parser Daemon
- [ ] Integrate `tree-sitter-language-pack` for multi-language syntax chunking (TypeScript, Python, R).
- [ ] Integrate `@llamaindex/liteparse` for layout-aware offline PDF and Word processing.
- [ ] Construct the thread-safe background queue with `chokidar` filesystem event debouncing.

### Phase 3: Consumer Interfaces
- [ ] Build the short-lived CLI client with native git branch detection (`@prag/cli`).
- [ ] Expose the native HTTP/SSE Model Context Protocol (MCP) server endpoint at `/mcp` directly inside `@prag/daemon` (see ADR-011).

---

## 💻 WIP Interface Blueprint

### Starting the Background Service
```bash
# The daemon lazily auto-spawns on first CLI/MCP use; to start it explicitly:
prag daemon start

# Then grant it a workspace to watch and index:
prag watch file:///home/user/projects/my-app
```

### Searching from the CLI
```bash
# The binary auto-detects your active git branch and project context and queries instantly
prag search-local "statistical variance check for matrices" --limit 3

# Or search across every registered project:
prag search-all "statistical variance check for matrices" --limit 3
```

### Connecting to an MCP Client (e.g., `claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "prag": {
      "url": "http://127.0.0.1:7724/mcp",
      "headers": {
        "Authorization": "Bearer <token from `prag daemon token`>"
      }
    }
  }
}
```
No separate process to launch: the MCP server runs inside the already-running (or lazily auto-spawned) `@prag/daemon`. Every endpoint except `/health` requires the bearer token (ADR-013); the CLI reads it automatically.

---

## 🔒 Security & Privacy

`prag` is self-hosted and local by default. Telemetry, analytics, and usage reporting are omitted by design, unconditionally. With no web URIs registered, `prag` makes zero outbound network calls: your code strings, structural graphs, document text, and vector floats never leave your machine. Outbound calls happen only for URIs you explicitly grant with `prag watch https://...`, and the web fetcher can be pointed at a self-hosted instance for a fully local deployment (see ADR-012).
