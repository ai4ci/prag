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

Set `PRAG_NO_SPAWN=1` to disable this entirely: the CLI then fails immediately with "no daemon running and PRAG_NO_SPAWN is set" rather than forking a detached process. For callers that manage daemon lifetime themselves, such as a test harness (ADR-019).

`GET /health` also reports the daemon's resolved `root`, `dataDir`, `configDir` and `runDir`, so a caller can confirm **which** instance it reached before invoking anything destructive (`prag reembed`, `prag prune --gc-chunks`). Paths only -- no indexed content or grant data.

### Port Identity & API-Version Checks (ADR-016)
Whenever the CLI finds something already listening on the configured port, it validates the `/health` response before trusting it -- **no automatic fallback to another port**:
- If `service !== "prag-daemon"`: fails loudly -- "Port <n> is in use by a different process. Set PRAG_PORT or server.port in config.json to use a different port, or stop the conflicting process."
- If `service === "prag-daemon"` but `apiVersion` differs from the CLI's own: fails loudly -- "Daemon speaks API version <X>, this CLI speaks <Y>. Run `prag daemon stop` to let it respawn at the current version."
- The daemon's package `version` is **never** compared -- it is reported in error output for diagnostics only. Only a deliberate `apiVersion` bump blocks a running daemon.

**Exempt commands:** `prag daemon stop`, `status`, `token` and `rotate-secret` skip the `apiVersion` check and work against any process identifying as `prag-daemon`. Otherwise the documented remedy above would fail with the error it is meant to clear.

---

### Command Reference

### `prag search-local <query>` / `prag search-all <query>` (ADR-018)
Executes hybrid semantic vector + BM25 full-text search against indexed content. `search-local` (the default/primary command for day-to-day use) searches exactly one project, resolving `projectId` from the current working directory the same way `--branch` is auto-detected. `search-all` searches every registered project and accepts no project option.

The split is for clarity, not access control: `search-local` with an explicit `--project` can reach any indexed project, so hiding `search-all` would restrict nothing. Per-caller restriction of results is tracked separately as `issue://search-result-permission-grants.md`.

```bash
prag search-local <query> [options]
prag search-all <query> [options]
```

#### Arguments & Options
| Option | Short | Type | Default | Description |
|---|---|---|---|---|
| `<query>` | | `string` | *(Required)* | Natural language concept, function name, symbol, or error string. |
| `--branch` | `-b` | `string` | *(Auto-detected)* | Git branch name. If omitted, auto-detects from local `.git/HEAD`. For non-git workspaces, uses `$default`. |
| `--project` | `-p` | `string` | *(cwd-resolved)* | **`search-local` only.** Override the `projectId` resolved from the current directory. `search-all` takes no project option -- searching everything is the whole point of the command. |
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
# Past ingestion.watchConfirmThreshold (default 25 projects / 20,000 files) this
# dry-runs discovery, prints what would be indexed, and requires --yes (ADR-023).
prag watch ~/Git --yes

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
- With `--gc-chunks`: additionally deletes unreferenced `chunks_pool` rows, cascades the delete to their `vector_pool` rows, and compacts both tables. Never runs automatically or on a schedule (ADR-017) -- omit the flag to only prune the lightweight pointer tables.
- The `--gc-chunks` sweep **drains and pauses the ingestion queue** for its duration, because dedup is a check-then-act sequence and a concurrent sweep would delete a chunk between the ingester's cache hit and its pointer write (ADR-017). Plain `prag prune` does not pause anything.

### `prag reembed [--model <name>]`
Rebuilds the index from scratch under a new (or the currently configured) embedding model (ADR-015). Required after changing `PRAG_EMBEDDING_MODEL` on an existing index -- on a mismatch the daemon refuses every request except `/health`, `/reembed` and `/shutdown` until this is run or the config is reverted.

This is **not** a vector swap. It drops every content-derived table (`branch_mapping`, `file_mapping`, `chunk_mapping`, `chunks_pool`, `vector_pool`), keeps `grants` and `projects`, writes the new sidecar, and enqueues a full rescan of every registered project. The command returns as soon as that is done -- the rebuild runs in the background on the normal ingestion queue. Track it with `prag status`; search is unavailable until the rebuild catches up.

---

### `prag pause <project>` / `prag resume <project>`
Sets and clears `projects.status = 'paused'` (ADR-023). A paused project keeps its grants and its indexed data; only scanning and ingestion stop. This is the off switch for a runaway scan that does not require deleting the grant and discarding completed work.

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
Executes hybrid semantic vector + BM25 keyword search scoped to exactly one project (ADR-018). This is the default/primary search tool. `projectId` is **required** -- unlike the CLI, an MCP client has no working directory the daemon can resolve, so omitting it is an error rather than a silent widening to every project.

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
        "description": "Project root URI to search (the projectId, e.g. file:///home/user/Git/prag). Required: the daemon hosts MCP in-process over HTTP/SSE and has no access to the caller's working directory, so it cannot derive this."
      },
      "branch": {
        "type": "string",
        "description": "Git branch context. Use '$default' for non-git projects and web content.",
        "default": "$default"
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
    "required": ["query", "projectId"]
  }
}
```

---

### Tool 1b: `search_all`
Executes the same hybrid search, unscoped across every registered project (ADR-018). Reserved for explicit cross-project/personal-knowledge-base queries. It deliberately accepts **no** `projectId` -- a project filter here would just be `search_local` under another name.

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
        "description": "Git branch context. Use '$default' for non-git projects and web content.",
        "default": "$default"
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

Past `ingestion.watchConfirmThreshold` this **fails** with `WATCH_LIMIT_EXCEEDED` rather than prompting, since an agent has no terminal to confirm at (ADR-023). The error's `details` carry the project and file counts the dry run found, so the agent can put the decision to the user, who can then run `prag watch <uri> --yes`.

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

## 3. Error Contract (ADR-022)

Every failure, on every endpoint, returns one envelope:

```json
{
  "error": {
    "code": "EMBEDDING_MODEL_MISMATCH",
    "message": "Configured embedding model bge-large does not match the model used to build this index (bge-small-en-v1.5, pinned 2026-10-28).",
    "remedy": "Run `prag reembed` to rebuild, or revert PRAG_EMBEDDING_MODEL to bge-small-en-v1.5.",
    "details": { "configured": "bge-large", "pinned": "bge-small-en-v1.5" }
  }
}
```

`code` is the contract -- a closed `SCREAMING_SNAKE` set exported by `@prag/core`, never localized, never reworded. Clients and tests branch on it and nothing else, so `message` stays free to improve. `remedy` is the action to take; `details` is optional structured context.

| Status | Meaning |
|---|---|
| `400` | malformed request body |
| `401` | missing/invalid bearer token, or rejected `Origin` (ADR-013) |
| `404` | unknown `projectId` |
| `409` | state conflict -- embedding model mismatch (ADR-015), rebuild already running |
| `422` | well-formed but invalid (e.g. `search_local` without `projectId`) |
| `503` | daemon starting, or index unavailable during a rebuild |
| `504` | `POST /sync` drain timeout (ADR-019) |
| `500` | unexpected -- always a bug; stack trace to the log, generic message to the caller |

### CLI Exit Codes
| Code | Meaning |
|---|---|
| `0` | success, **including a search that matched nothing** -- empty results are an answer, not an error |
| `1` | unexpected failure |
| `2` | usage error |
| `3` | no daemon running (spawn failed, or `PRAG_NO_SPAWN=1`) |
| `4` | daemon identity or `apiVersion` mismatch (ADR-016) |
| `5` | authentication failure |
| `6` | embedding model mismatch -- `prag reembed` required (ADR-015) |
| `7` | URI not granted, or unknown project |
| `8` | timeout |

Default CLI output prints `message`, then `remedy`. `--json` emits the envelope verbatim. MCP tool failures carry `code` and `message` into the MCP error so an agent gets a machine-readable reason.

---

## 4. Daemon Loopback HTTP/JSON Protocol

The daemon exposes an internal REST/JSON API strictly bound to `127.0.0.1:<port>`:

| Method | Endpoint | Description | Payload / Response |
|---|---|---|---|
| `GET` | `/health` | Daemon heartbeat, identity & resolved paths | `{ status: "ok", service: "prag-daemon", apiVersion: number, pid: number, port: number, version: string, uptime: number, root: string, dataDir: string, configDir: string, runDir: string }` |
| `GET` | `/mcp` | MCP Server-Sent Events (SSE) stream | Initiates persistent MCP protocol session |
| `POST` | `/mcp` | MCP client JSON-RPC message target | Standard MCP request/notification payload |
| `POST` | `/search` | Executes hybrid search | Body: `SearchQueryOptions` $\to$ Returns: `SearchHitResult[]` |
| `GET` | `/grants` | Lists active grant rules | Returns: `UriGrant[]` |
| `POST` | `/grants` | Adds allow or deny rule | Body: `{ pattern: string, action: 'allow'|'deny', reason?: string }` |
| `DELETE` | `/grants` | Removes an active rule | Body: `{ pattern: string }` |
| `GET` | `/projects` | Lists registered projects | Returns: `ProjectRecord[]` |
| `POST` | `/sync` | Drain barrier: force reconciliation and flush | Body: `{ projectId?: string }` $\to$ Returns once the queue is empty and all writes are committed: `{ synced: true, flushedFiles: number, pendingFiles: number }` |
| `POST` | `/prune` | Run branch pruning & GC | Body: `{ gcChunks?: boolean }` (default `false`) $\to$ Returns: `{ prunedBranches: number, purgedChunks: number }` |
| `POST` | `/reembed` | Drop content tables and requeue a full rebuild under a new model | Body: `{ model?: string }` $\to$ Returns immediately: `{ requeued: number }` (projects enqueued) |
| `POST` | `/shutdown`| Graceful daemon exit | Flushes queues and terminates process cleanly. |
