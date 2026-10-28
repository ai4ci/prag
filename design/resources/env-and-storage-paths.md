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
│   ├── grants.lance/             # Allow/deny URI grants table
│   ├── projects.lance/           # Registered project workspaces & tracking modes
│   ├── branch_mapping.lance/     # Branch heads pointing to file commit hashes
│   ├── file_mapping.lance/       # Content-addressable file metadata & chunk lists
│   ├── chunk_mapping.lance/      # File-to-chunk location mapping (line numbers, AST scope)
│   └── chunks_pool.lance/        # Global content-deduplicated chunks & 384-dim dense vectors
└── models/
    └── Xenova/
        └── bge-small-en-v1.5/    # Downloaded ONNX model weights and tokenizer files
```

### Runtime Directory (`PRAG_RUN_DIR`)
```text
~/.local/state/prag/
├── daemon.pid                    # Stores PID of currently running background daemon
├── daemon.port                   # Active loopback port number (e.g., 7724)
└── daemon.sock                   # Optional local UNIX domain socket (if enabled)
```

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
| `PRAG_DATA_DIR` | `string` | `~/.local/share/prag` | Path to persistent LanceDB tables and model weight caches. |
| `PRAG_CONFIG_DIR` | `string` | `~/.config/prag` | Path to user configuration JSON file (`config.json`). |
| `PRAG_RUN_DIR` | `string` | `~/.local/state/prag` | Path where PID and port discovery files are written. |
| `PRAG_LOG_DIR` | `string` | `~/.local/state/prag/logs` | Path where daemon operational logs are written. |
| `PRAG_PORT` | `integer` | `7724` | Loopback HTTP port for the daemon (`127.0.0.1:<port>`). |
| `PRAG_HOST` | `string` | `127.0.0.1` | Bind host (strictly local loopback). |
| `PRAG_EMBEDDING_MODEL`| `string` | `Xenova/bge-small-en-v1.5` | Hugging Face / Transformers.js model identifier for ONNX embeddings. |
| `PRAG_EMBEDDING_DEVICE`| `string` | `cpu` | ONNX runtime device target (`cpu`, `cuda`, `directml`, `wasm`). |
| `PRAG_BATCH_SIZE` | `integer` | `64` | Maximum number of text chunks per ONNX inference batch. |
| `PRAG_DEBOUNCE_MS` | `integer` | `500` | Ingestion queue debounce window for filesystem change events. |
| `PRAG_LOG_LEVEL` | `string` | `info` | Logging verbosity: `error`, `warn`, `info`, `debug`, `trace`. |

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
    "batchSize": 64
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
  }
}
```
