# prag Configuration, Environment Variables, and Storage Paths

This document defines standard filesystem locations, environment variables, and configuration paths utilized across `@prag/core`, `@prag/daemon`, `@prag/cli`, and `@prag/mcp`.

---

## 1. Operating System Storage Standards (XDG)

`prag` complies with standard OS directory specifications (XDG Base Directory Specification on Linux/macOS, `%APPDATA%` / `%LOCALAPPDATA%` on Windows).

### Base Path Resolution Table

| Path Type | Linux / macOS (XDG default) | macOS (Fallback) | Windows |
|---|---|---|---|
| **Data Directory** | `~/.local/share/prag` (`$XDG_DATA_HOME/prag`) | `~/Library/Application Support/prag` | `%LOCALAPPDATA%\prag` |
| **Config Directory** | `~/.config/prag` (`$XDG_CONFIG_HOME/prag`) | `~/Library/Preferences/prag` | `%APPDATA%\prag` |
| **Runtime / State** | `~/.local/state/prag` or `/run/user/<uid>/prag` | `~/Library/Caches/prag/run` | `%LOCALAPPDATA%\prag\run` |
| **Log Directory** | `~/.local/state/prag/logs` (`$XDG_STATE_HOME/prag/logs`) | `~/Library/Logs/prag` | `%LOCALAPPDATA%\prag\logs` |

---

## 2. Specific Storage Files and Directories

Inside the resolved base paths, `prag` maintains the following structured files:

### Data Directory (`PRAG_DATA_DIR`)
```text
~/.local/share/prag/
├── lancedb/
│   ├── .embedding-model.json     # { model, dim, maxVectorUnitTokens, pinnedAt } -- model the index was built with (ADR-015)
│   ├── grants.lance/             # Allow/deny URI grants table
│   ├── projects.lance/           # Registered project workspaces & tracking modes
│   ├── branch_mapping.lance/     # Branch heads pointing to file commit hashes
│   ├── file_mapping.lance/       # Content-addressable file metadata & chunk lists
│   ├── chunk_mapping.lance/      # File-to-chunk location mapping (line numbers, AST scope)
│   ├── chunks_pool.lance/        # Global content-deduplicated chunk text (BM25 FTS indexed)
│   └── vector_pool.lance/        # Dense vectors per vectorised unit, keyed (chunkHash, unitIndex)
└── models/
    └── Xenova/
        └── bge-small-en-v1.5/    # Downloaded ONNX model weights and tokenizer files
```

### Runtime Directory (`PRAG_RUN_DIR`)
```text
~/.local/state/prag/
├── daemon.pid                    # Stores PID of currently running background daemon
├── daemon.port                   # Active loopback port number (e.g., 7724)
└── daemon.token                  # Bearer token for HTTP/MCP auth, mode 0600 (legacy; superseded by PRAG_API_KEY)
```

> **Auth precedence:** The daemon authenticates against `PRAG_API_KEY` (default `"guest"`). `daemon.token` is written at startup only when `PRAG_API_KEY` is the default, for backward compatibility with tools that read the file. Setting `PRAG_API_KEY` explicitly skips writing the file; callers should use the env var directly.

### Path Precedence (ADR-019)
For each of the four categories, the first match wins:
1. the explicitly set category variable (`PRAG_DATA_DIR`, `PRAG_CONFIG_DIR`, `PRAG_RUN_DIR`, `PRAG_LOG_DIR`);
2. the path derived from `PRAG_ROOT`, if it is set;
3. the XDG / platform default from the table above.

When `PRAG_ROOT` is set, an unset category **never** falls back to an XDG path. One variable therefore isolates an entire instance, and deleting that one directory removes every trace of it. This matters because `prag reembed` (ADR-015) and `prag prune --gc-chunks` (ADR-017) are destructive: partial isolation is how a test run destroys a real index.

### Configuration Directory (`PRAG_CONFIG_DIR`)
```text
~/.config/prag/
└── config.json                   # User configuration overrides (JSON)
```

### Logs Directory (`PRAG_LOG_DIR`)
```text
~/.local/state/prag/logs/
├── daemon.log                    # Standard stdout/stderr stream from background daemon
└── daemon.error.log              # Dedicated crash & unhandled exception logs
```

---

## 3. Environment Variables Reference

Every setting can be specified or overridden using environment variables prefixed with `PRAG_`:

| Environment Variable | Type | Default Value | Description |
|---|---|---|---|
| `PRAG_ROOT` | `string` | *(unset)* | Single isolation override. When set, all four base directories derive from it: `<root>/data`, `<root>/config`, `<root>/state`, `<root>/state/logs`. See precedence below (ADR-019). |
| `PRAG_DATA_DIR` | `string` | `~/.local/share/prag` | Path to persistent LanceDB tables and model weight caches. |
| `PRAG_CONFIG_DIR` | `string` | `~/.config/prag` | Path to user configuration JSON file (`config.json`). |
| `PRAG_RUN_DIR` | `string` | `~/.local/state/prag` | Path where PID and port discovery files are written. |
| `PRAG_LOG_DIR` | `string` | `~/.local/state/prag/logs` | Path where daemon operational logs are written. |
| `PRAG_PORT` | `integer` | `7724` | Loopback HTTP port for the daemon (`127.0.0.1:<port>`). `0` binds a kernel-assigned ephemeral port, written to `daemon.port` as usual -- the only supported way to run daemons in parallel (ADR-019). |
| `PRAG_NO_SPAWN` | `boolean` | `false` | When `1`, the CLI never lazily auto-spawns a daemon; it fails immediately instead. For callers that own daemon lifetime, such as a test harness (ADR-019). |
| `PRAG_HOST` | `string` | `127.0.0.1` | Bind host (strictly local loopback). |
| `PRAG_EMBEDDING_MODEL`| `string` | `Xenova/bge-small-en-v1.5` | Hugging Face / Transformers.js model identifier for ONNX embeddings. Also accepts `fake:<dim>` (e.g. `fake:384`) to select the deterministic built-in embedder -- offline and instant, but **not** semantically meaningful (ADR-019). |
| `PRAG_EMBEDDING_DEVICE`| `string` | `cpu` | ONNX runtime device target (`cpu`, `cuda`, `directml`, `wasm`). |
| `PRAG_API_KEY` | `string` | `guest` | Shared secret for daemon HTTP/MCP auth. All requests except `GET /health` must carry `Authorization: Bearer <PRAG_API_KEY>`. Default `"guest"` provides no security — set to a unique value in production. Future access control hook. |
| `PRAG_BATCH_SIZE` | `integer` | `64` | Maximum number of text chunks per ONNX inference batch. |
| `PRAG_DEBOUNCE_MS` | `integer` | `500` | Ingestion queue debounce window for filesystem change events. |
| `PRAG_WORKER_POOL_SIZE` | `integer` | `1` | Parse/chunk/hash worker threads. Embedding and all database writes stay on the main thread regardless (ADR-021). |
| `PRAG_MAX_FILE_BYTES` | `integer` | `2097152` | Files larger than this are skipped at discovery and counted as `tooLarge` in `prag status` (ADR-023). |
| `PRAG_LOG_LEVEL` | `string` | `info` | Logging verbosity: `error`, `warn`, `info`, `debug`, `trace`. |
| `PRAG_WEB_BACKEND` | `string` | `plain-fetcher` | Which `WebFetchBackend` performs web ingestion: `plain-fetcher`, `firecrawl`, or `exa` (ADR-024). No automatic fallback -- an unreachable or unknown id is a startup error. |
| `PRAG_FIRECRAWL_URL` | `string` | *(unset)* | Self-hosted Firecrawl endpoint. Unset **with** `firecrawl` selected requires `PRAG_FIRECRAWL_API_KEY`, so a typo cannot quietly move egress to the hosted API. |
| `PRAG_EXA_API_KEY` | `string` | *(unset)* | Exa API key. Exa is an index, not a crawler: it declares `fetch` + `search` and glob grants against it fail with `CRAWL_CAPABILITY_UNAVAILABLE` (ADR-024). |

---

## 4. User Configuration File (`config.json`)

If present at `~/.config/prag/config.json`, the daemon loads defaults from this file:

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 7724,
    "debounceMs": 500
  },
  "embedding": {
    "model": "Xenova/bge-small-en-v1.5",
    "device": "cpu",
    "batchSize": 64,
    "maxVectorUnitTokens": 400,
    "vectorUnitOverlapTokens": 60
  },
  "ingestion": {
    "workerPoolSize": 1,
    "maxFileBytes": 2097152,
    "watchConfirmThreshold": { "projects": 25, "files": 20000 }
  },
  "storage": {
    "dataDir": null,
    "runDir": null
  },
  "defaults": {
    "localCooldownSeconds": 60,
    "webCooldownSeconds": 86400,
    "defaultSearchLimit": 5,
    "defaultSearchMode": "hybrid"
  },
  "web": {
    "backend": "plain-fetcher",
    "firecrawl": { "url": null, "apiKey": null },
    "exa": { "apiKey": null }
  }
}
```

`web.backend` selects exactly one ingestion backend (`plain-fetcher` | `firecrawl` |
`exa`); unknown or unreachable values fail at startup rather than falling back to
another backend, since relocating egress silently is the failure ADR-024 exists to
prevent. Credentials for a hosted backend are supplied here or by the env vars
below; a hosted fetch backend never permits a hosted inference endpoint (ADR-006).
