# prag Interface Specification (CLI & Native HTTP/SSE MCP Endpoint)

This document specifies the user-facing and agent-facing interfaces for `prag`:
1. The short-lived **Command Line Interface (CLI)** (`@prag/cli`).
2. The co-located **Model Context Protocol (MCP) Server** running directly inside `@prag/daemon` over HTTP/SSE.
3. The underlying **Daemon HTTP/JSON Loopback API** (`@prag/daemon`).

---

## 1. Command Line Interface (CLI)

The CLI binary (`prag`) is a short-lived client. Every command communicates with the background daemon over loopback HTTP (`http://127.0.0.1:<port>`).

### Lazy Daemon Startup
If the daemon is not running when any CLI command is invoked:
1. CLI detects that `GET /health` fails on the configured port.
2. CLI spawns `@prag/daemon` in the background (`child_process.spawn(..., { detached: true, stdio: 'ignore' })`).
3. CLI polls `GET /health` until status returns `"ok"` (timeout: 5 seconds).
4. CLI proceeds with the user's requested command seamlessly.

### Port Identity & Version Checks (ADR-016)
Whenever the CLI finds something already listening on the configured port (whether via lazy-spawn or `prag daemon status`), it validates the `/health` response before trusting it -- **no automatic fallback to another port**:
- If `service !== "prag-daemon"`: fails loudly -- "Port <n> is in use by a different process. Set PRAG_PORT or server.port in config.json to use a different port, or stop the conflicting process."
- If `service === "prag-daemon"` but `version` differs from the CLI's own version: fails loudly -- "Daemon version <X> does not match CLI version <Y>. Run `prag daemon stop` to let it respawn at the current version, or align versions manually."

---

### Command Reference

### `prag search-local <query>` / `prag search-all <query>` (ADR-018)
Executes hybrid semantic vector + BM25 full-text search against indexed content. `search-local` (the default/primary command for day-to-day use) resolves `projectId` from the current working directory the same way `--branch` is auto-detected, and searches only that project. `search-all` omits project scoping and searches every registered project. A future grants-like permission may restrict which contexts can invoke `search-all` (deferred, not implemented now).

```bash
prag search-local <query> [options]
prag search-all <query> [options]
```

#### Arguments & Options
| Option | Short | Type | Default | Description |
|---|---|---|---|---|
| `<query>` | | `string` | *(Required)* | Natural language concept, function name, symbol, or error string. |
| `--branch` | `-b` | `string` | *(Auto-detected)* | Git branch name. If omitted, auto-detects from local `.git/HEAD`. For non-git workspaces, uses `$default`. |
| `--project` | `-p` | `string` | *(cwd-resolved for `search-local`; unset for `search-all`)* | Override the resolved `projectId` (`search-local`), or narrow `search-all` to one project without fully scoping it the way `search-local` does. |
| `--limit` | `-n` | `integer` | `5` | Maximum number of matched code/document chunks to return. |
| `--mode` | `-m` | `enum` | `hybrid` | Search execution mode: `hybrid` (dense + BM25 RRF), `vector` (dense only), or `fts` (BM25 only). |
| `--json` | | `boolean` | `false` | Output machine-readable JSON array of hits instead of styled terminal cards. |

#### Terminal Output Example
```text
$ prag search-local "handle file debounce in daemon" -n 2

[Hit 1] (score: 0.0321) @prag/daemon (branch: main)
File: packages/daemon/src/queue/ingestion-queue.ts:42-88 (typescript)
--------------------------------------------------------------------------------
42 | export class IngestionQueue {
43 |   private dirtySet: Set<string> = new Set();
...
88 | }

[Hit 2] (score: 0.0298) @prag/core (branch: main)
File: design/features/background-worker-queue.md:25-45 (markdown)
...
```

---

### `prag watch <uri>`
Adds an `allow` grant for the given URI pattern and triggers initial discovery/ingestion.

```bash
# Watch a specific repository (CLI expands ~ and relative paths to an absolute file:/// URI before sending to the daemon):
prag watch ~/Git/prag

# Watch a container directory (discovers all child git repositories):
prag watch ~/Git

# Watch remote online documentation:
prag watch https://docs.lancedb.com/**
```
Note: `grants.pattern` always stores the normalized absolute form (e.g. `file:///home/user/Git/prag/**`); `~` and relative paths are a CLI-only convenience, never stored or matched literally.

---

### `prag deny <uri>`
Adds a `deny` grant for the given URI pattern, purges existing index data, and un-watches the path.

```bash
# Exclude a sensitive repository or directory:
prag deny ~/Git/my-secret-project
```

---

### `prag grants`
Lists all active allow and deny policy rules stored in the database.

---

### `prag status [uri]`
Inspects daemon health, indexing queues, and repository status.

---

### `prag projects`
Lists all registered project containers, their root URIs, and branch tracking modes.

---

### `prag sync [uri]`
Manually triggers an immediate scan, reconciles current Git branches, and flushes debounced queues.

---

### `prag prune [--gc-chunks]`
Cleans up stale data:
- Purges `branch_mapping` entries for Git branches that no longer exist.
- Performs garbage collection on unreferenced `file_mapping` and `chunk_mapping` records.
- With `--gc-chunks`: additionally deletes unreferenced `chunks_pool` rows and compacts the table. Never runs automatically or on a schedule (ADR-017) -- omit the flag to only prune the lightweight pointer tables.

### `prag reembed [--model <name>]`
Re-embeds every `chunks_pool.text` row with a new (or the currently configured) embedding model, then updates the pinned `.embedding-model.json` sidecar on success (ADR-015). Required after changing `PRAG_EMBEDDING_MODEL` on an existing index -- the daemon refuses to write to `chunks_pool` until this is run or the config is reverted.

---

### `prag daemon <start|stop|status|token|rotate-secret>`
Manual control over the persistent daemon service:
- `prag daemon start`: Starts daemon in background if not already running.
- `prag daemon stop`: Sends `POST /shutdown` to terminate gracefully.
- `prag daemon status`: Prints PID, port, memory RSS, and uptime.
- `prag daemon token`: Prints the current bearer token (for pasting into an MCP host's `headers` config).
- `prag daemon rotate-secret`: Regenerates `daemon.token`, invalidating the previous one immediately.

---

## 2. Model Context Protocol (MCP) Server (Native HTTP/SSE)

The MCP server is hosted **directly inside `@prag/daemon`** at the `/mcp` route on the daemon's loopback port (`http://127.0.0.1:7724/mcp`). AI assistants (Claude Desktop, Cursor, pi, VS Code) connect directly to this endpoint using the MCP HTTP/Server-Sent Events (SSE) transport.

### Host Registration Example (e.g. `mcpServers` config)
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
All endpoints except `GET /health` require this bearer token (ADR-013); the CLI attaches it automatically by reading `daemon.token` from the runtime directory.

### In-Process Architecture
Because the MCP server runs inside the daemon process:
- It uses zero duplicate memory; warm ONNX embeddings and LanceDB instances are accessed directly in-memory.
- Queries and commands execute with sub-millisecond dispatch.

---

### MCP Tools Provided

### Tool 1a: `search_local`
Executes hybrid semantic vector + BM25 keyword search scoped to the calling workspace's project only (ADR-018). This is the default/primary search tool.

#### JSON-Schema Input Contract:
```json
{
  "name": "search_local",
  "description": "Performs hybrid semantic vector and keyword search scoped to the current project workspace only.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "Natural language question, logic description, function name, symbol, or error string."
      },
      "projectId": {
        "type": "string",
        "description": "Project workspace slug to search. If omitted, resolved from the caller's current workspace context."
      },
      "branch": {
        "type": "string",
        "description": "Git branch context (defaults to current git branch, or '$default' for non-git/web).",
        "default": "main"
      },
      "limit": {
        "type": "integer",
        "description": "Maximum number of distinct code chunks or document paragraphs to return.",
        "default": 5
      },
      "mode": {
        "type": "string",
        "enum": ["hybrid", "vector", "fts"],
        "description": "Search execution mode: hybrid (default), pure vector, or pure full-text.",
        "default": "hybrid"
      }
    },
    "required": ["query"]
  }
}
```

---

### Tool 1b: `search_all`
Executes the same hybrid search, unscoped across every registered project (ADR-018). Reserved for explicit cross-project/personal-knowledge-base queries; a future grants-like permission may restrict which MCP clients can call this tool (deferred, not implemented now).

#### JSON-Schema Input Contract:
```json
{
  "name": "search_all",
  "description": "Performs hybrid semantic vector and keyword search across every registered project, with no project scoping.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "Natural language question, logic description, function name, symbol, or error string."
      },
      "branch": {
        "type": "string",
        "description": "Git branch context (defaults to current git branch, or '$default' for non-git/web).",
        "default": "main"
      },
      "limit": {
        "type": "integer",
        "description": "Maximum number of distinct code chunks or document paragraphs to return.",
        "default": 5
      },
      "mode": {
        "type": "string",
        "enum": ["hybrid", "vector", "fts"],
        "description": "Search execution mode: hybrid (default), pure vector, or pure full-text.",
        "default": "hybrid"
      }
    },
    "required": ["query"]
  }
}
```

---

### Tool 2: `get_indexing_status`
Enables an agent to determine if a workspace or URI is indexed, its current branch, and chunk count.

#### JSON-Schema Input Contract:
```json
{
  "name": "get_indexing_status",
  "description": "Checks whether a directory or URI is indexed in prag, returning status, active branch, and chunk count.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "uri": {
        "type": "string",
        "description": "The file URI (file:///...) or web URL to inspect. If omitted, checks current workspace."
      }
    }
  }
}
```

---

### Tool 3: `watch_uri`
Allows an agent to proactively register a directory or remote documentation URL for indexing.

#### JSON-Schema Input Contract:
```json
{
  "name": "watch_uri",
  "description": "Adds an allow grant and registers a directory or web URL for background indexing.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "uri": {
        "type": "string",
        "description": "Directory URI (file:///path/to/repo) or documentation URL (https://docs.site.com/**)."
      },
      "cooldownSeconds": {
        "type": "integer",
        "description": "Cooldown validity lease delta in seconds (default: 60 for local, null for web)."
      }
    },
    "required": ["uri"]
  }
}
```

---

### Tool 4: `deny_uri`
Allows an agent to exclude a sensitive directory or repository and halt indexing immediately.

#### JSON-Schema Input Contract:
```json
{
  "name": "deny_uri",
  "description": "Excludes a URI pattern from indexing, removing existing chunks from search and halting file watching.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "uri": {
        "type": "string",
        "description": "The URI pattern to exclude (e.g. file:///path/to/secret/**)."
      }
    },
    "required": ["uri"]
  }
}
```

---

### Tool 5: `prune_index`
Removes stale `branch_mapping` pointers and, only if explicitly requested, garbage-collects unreferenced `chunks_pool` rows (ADR-017). Never runs automatically; this tool is the MCP-side equivalent of `prag prune [--gc-chunks]`.

#### JSON-Schema Input Contract:
```json
{
  "name": "prune_index",
  "description": "Prunes stale branch pointers, and optionally garbage-collects unreferenced content-pool chunks.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "gcChunks": {
        "type": "boolean",
        "description": "Also delete unreferenced chunks_pool rows and compact the table. Defaults to false -- must be explicitly requested.",
        "default": false
      }
    }
  }
}
```

---

## 3. Daemon Loopback HTTP/JSON Protocol

The daemon exposes an internal REST/JSON API strictly bound to `127.0.0.1:<port>`:

| Method | Endpoint | Description | Payload / Response |
|---|---|---|---|
| `GET` | `/health` | Daemon heartbeat & status | `{ status: "ok", service: "prag-daemon", pid: number, port: number, version: string, uptime: number }` |
| `GET` | `/mcp` | MCP Server-Sent Events (SSE) stream | Initiates persistent MCP protocol session |
| `POST` | `/mcp` | MCP client JSON-RPC message target | Standard MCP request/notification payload |
| `POST` | `/search` | Executes hybrid search | Body: `SearchQueryOptions` $\to$ Returns: `SearchHitResult[]` |
| `GET` | `/grants` | Lists active grant rules | Returns: `UriGrant[]` |
| `POST` | `/grants` | Adds allow or deny rule | Body: `{ pattern: string, action: 'allow'|'deny', reason?: string }` |
| `DELETE` | `/grants` | Removes an active rule | Body: `{ pattern: string }` |
| `GET` | `/projects` | Lists registered projects | Returns: `ProjectRecord[]` |
| `POST` | `/sync` | Force reconciliation | Body: `{ projectId?: string }` $\to$ Returns: `{ synced: true }` |
| `POST` | `/prune` | Run branch pruning & GC | Body: `{ gcChunks?: boolean }` (default `false`) $\to$ Returns: `{ prunedBranches: number, purgedChunks: number }` |
| `POST` | `/reembed` | Re-embed `chunks_pool` with a new model | Body: `{ model?: string }` $\to$ Returns: `{ reembedded: number }` |
| `POST` | `/shutdown`| Graceful daemon exit | Flushes queues and terminates process cleanly. |
