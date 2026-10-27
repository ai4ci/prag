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
* **Local Content Retention:** Raw text segments are cached directly inside LanceDB alongside vector floats, making query retrieval resilient against uncommitted edits and rapid workspace branch hopping.

---

## 🚦 Roadmap & Work in Progress

### Phase 1: Storage & Shared Core (Current WIP)
- [ ] Define shared TypeScript database model definitions (`@prag/core`).
- [ ] Implement LanceDB initialization scripts with dual table setups (`chunks_pool` and `file_mapping`).

### Phase 2: Ingestion & Parser Daemon
- [ ] Integrate `tree-sitter-language-pack` for multi-language syntax chunking (TypeScript, Python, R).
- [ ] Integrate `@llamaindex/liteparse` for layout-aware offline PDF and Word processing.
- [ ] Construct the thread-safe background queue with `chokidar` filesystem event debouncing.

### Phase 3: Consumer Interfaces
- [ ] Build the short-lived CLI client with native git branch detection (`@prag/cli`).
- [ ] Expose the standard input/output (`stdio`) Model Context Protocol (MCP) server tool framework.

---

## 💻 WIP Interface Blueprint

### Starting the Background Service
```bash
# Spin up the persistent file watcher and local model inference queue
node packages/daemon/dist/index.js --watch ~/projects/my-app
```

### Searching from the CLI
```bash
# The binary auto-detects your active git branch context and queries instantly
prag search "statistical variance check for matrices" --limit 3
```

### Connecting to an MCP Client (e.g., `claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "prag": {
      "command": "node",
      "args": ["/path/to/prag/packages/daemon/dist/mcp.js"]
    }
  }
}
```

---

## 🔒 Security & Privacy

`prag` is strictly air-gapped. Telemetry, telemetry wrappers, and remote API calls are omitted by design. Your code strings, structural graphs, document text, and vector floats never leave your machine.
