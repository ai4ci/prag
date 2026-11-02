# prag 🚀

`prag` (**Pragmatic RAG) is a fast, local-first semantic search and RAG indexing engine for mixed codebases and documentation repositories. It is built specifically to handle high file churn, understand Git branches natively, and keep local content on the machine: parsing, chunking, embedding and storage all run inside your local workstation's hardware perimeter, and a full index-and-search cycle over local content works with the network unreachable.

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

## 🚀 Getting Started

### Prerequisites

- **Node.js ≥ 22** (declared in `engines`). Native addons decide this: LanceDB and the
  tree-sitter grammars ship prebuilt binaries per Node ABI and platform, so an unsupported
  Node fails at load with a native-addon error, not a friendly message.
- **Linux or macOS.** Windows is untested.
- **Disk/network for the default model.** The default embedder is a local ONNX model
  (`Xenova/bge-small-en-v1.5`, 34 MB quantized) downloaded on first real embed, then reused
  offline. It caches under `node_modules/@huggingface/transformers/.cache/`, *not* under
  `PRAG_ROOT` — so `npm ci` throws the download away, and two clones each fetch their own copy.
  To try prag without any download, set `PRAG_EMBEDDING_MODEL=fake:384` — a deterministic
  hash-based stand-in. Search quality is meaningless with `fake:`, but the whole pipeline runs.

### Install from source

There is no published package and no single-binary build yet (`task:toolchain-spike-native-addons.md`
decides which). From a clone:

```bash
npm install            # native addons unpack here; also links node_modules/.bin/prag
node_modules/.bin/prag --version
```

To get `prag` on your PATH, `npm link --workspace @prag/cli` (needs a writable global prefix —
true under nvm/volta; otherwise `NPM_CONFIG_PREFIX=$HOME/.local/npm-prefix npm link --workspace
@prag/cli` and add that `bin/` to PATH).

`prag` is `packages/cli/bin/prag.mjs`, a two-line wrapper that registers the `tsx` ESM loader and
runs the TypeScript sources — the same code path the tests use. A compiled artifact is still open
work; this is the one route that works today.

### Index something and search it

```bash
prag daemon start                             # writes runDir/daemon.port (+ daemon.token)
prag watch ~/code/my-project                  # allow-grant + register as a project
prag sync                                     # drain the queue; prints flushed/pending counts

cd ~/code/my-project
prag search-local "how do we retry failed requests"
```

`watch` uses the directory's `file://` URI as the project id, which is what `search-local`
resolves your working directory against — so after `cd`, no `-p` is needed.

### Where things live, and how to get an isolated instance

Default root is `$XDG_STATE_HOME`/`$XDG_DATA_HOME`-based (see
[`design/resources/env-and-storage-paths.md`](design/resources/env-and-storage-paths.md)): the
LanceDB directory, `runDir/daemon.port`, `runDir/daemon.token` and logs. Set `PRAG_ROOT=/tmp/prag-test`
for a throwaway instance — everything, including the port file, moves under it.

The bearer token comes from `PRAG_API_KEY`; unset, it defaults to `guest` and prag writes
`runDir/daemon.token` with mode `0600`. The CLI reads that file, so you rarely handle it.

### Verify your install

```bash
npm test        # 92 core + 109 daemon + 33 cli, ~20s
npm run lint
```

---

## ⚡ Core Architectural Decisions (ADRs)

* **Content-Addressable Storage (CAS):** File contents are parsed and embedded *exactly once* based on their unique cryptographic hash. Git checkouts or branches sharing identical code blocks consume zero extra CPU/GPU cycles and zero duplicate disk footprint.
* **Pre-Filtering Matrix Layer:** Branch-awareness is enforced via LanceDB's fast scalar predicates. Filtering out irrelevant branches is executed at the native disk layout layer *before* scoring vector distances.
* **Local Content Retention:** Raw text segments are cached directly inside LanceDB (`chunks_pool`) alongside their embeddings (`vector_pool`), making query retrieval resilient against uncommitted edits and rapid workspace branch hopping.
* **Chunks vs Vectorised Units:** A chunk is one whole structural unit and is always returned whole. When a chunk is too large for the embedding model, it is embedded as several overlapping windows under one hash rather than being split (see ADR-014).

---

## 🚦 Roadmap & Work in Progress

### Phase 1: Storage & Shared Core — complete
- [x] Define shared TypeScript database model definitions (`@prag/core`).
- [x] Implement LanceDB initialization scripts for the 7-table schema (`grants`, `projects`, `branch_mapping`, `file_mapping`, `chunk_mapping`, `chunks_pool`, `vector_pool`).

### Phase 2: Ingestion & Parser Daemon (Current WIP)
- [x] Integrate `tree-sitter-language-pack` for multi-language syntax chunking (TypeScript, Python, R).
- [ ] Integrate `@llamaindex/liteparse` for layout-aware offline PDF and Word processing.
- [x] Construct the thread-safe background queue with `chokidar` filesystem event debouncing.

### Phase 3: Consumer Interfaces
- [x] Build the short-lived CLI client (`@prag/cli`).
- [ ] Add native git branch detection to the CLI and scope search by branch.
- [x] Expose the native HTTP/SSE Model Context Protocol (MCP) server endpoint at `/mcp` directly inside `@prag/daemon` (see ADR-011).

### Known gaps

Design requirements not yet implemented:

- [ ] LiteParse PDF/DOCX layout extraction; unsupported documents are refused by extension today.
- [ ] Web ingestion: the pluggable fetch-backend interface (ADR-024) and its `plain-fetcher` /
      Firecrawl / Exa backends.
- [ ] Hardware-acceleration provider selection and local-first enforcement check.
- [ ] Bun native-addon spike.
- [ ] No published package or single-binary artifact — `prag` installs by `npm link` from a clone
      (`issue:no-installation-instructions.md`).

---

## 💻 WIP Interface Blueprint

### Starting the Background Service
```bash
# The daemon lazily auto-spawns on first CLI/MCP use; to start it explicitly:
prag daemon start

# Then grant it a workspace to watch and index (allow grant + project registration):
prag watch file:///home/user/projects/my-app
```

### Searching from the CLI
```bash
# Scoped to the project your working directory belongs to. The branch comes from
# the project's .git/HEAD; --branch overrides it. Outside every registered
# project this is an error, not a search over everything (ADR-018).
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

`prag` is self-hosted and local by default. Telemetry, analytics, and usage reporting are omitted by design, unconditionally. Content that lives on your machine never leaves it: your code strings, structural graphs, document text, and vector floats are parsed, embedded and stored locally, and a local index-and-search cycle completes with the network unreachable. Outbound calls happen only for URIs you explicitly grant with `prag watch https://...`, through the web-fetch backend you selected (`plain-fetcher`, Firecrawl, or Exa — self-hosted or hosted), which `prag status` reports so the current egress path is always inspectable. Web fetching is the one part of prag that is not local-first, and it never involves a remote inference endpoint: embeddings stay local (see ADR-024, ADR-006).
