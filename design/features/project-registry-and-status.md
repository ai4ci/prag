---
class: feature
id: project-registry-and-status.md
title: Unified Allow/Deny URI Grants and Database-Backed Project Discovery
status: accepted
priority: high
area: daemon
guided-by:
  - adr://ADR-009.md
---
## Overview
Indexing targets and monitoring boundaries are governed by a centralized, database-backed **Allow/Deny URI Grants** policy rule set (`grants` table) in LanceDB. The system decouples policy permissions from versioned project containers (`projects` table), operating uniformly over normalized URIs (`file:///...` and `https://...`) without dirtying user repositories with marker files (`.prag`).

## Unified URI Grants Architecture (`grants` Table)
Access permissions are defined as allow/deny rules over URI patterns:
```typescript
export interface UriGrant {
  pattern: string; // e.g. "file:///home/user/Git/**", "file:///home/user/Git/secret/**"
  action: 'allow' | 'deny';
  reason: 'watch_root' | 'explicit_grant' | 'user_deny' | 'builtin_ignore';
  createdAt: Date;
}
```

### Evaluation Semantics
1. **Deny by default:** A URI is only inspected, watched, or indexed if matched by an `allow` grant.
2. **Longest Prefix Match (Most Specific Rule Wins):** A specific `deny` pattern (e.g. `file:///home/user/Git/secret/**`) takes precedence over a broader container `allow` pattern (e.g. `file:///home/user/Git/**`).
3. **Deny Breaks Ties:** If allow and deny match at identical length/specificity, `deny` takes precedence.
4. **Built-in Global Denials:** Evaluated automatically for vendor noise (e.g. `**/node_modules/**`, `**/.git/**`, `**/dist/**`, `**/build/**`, `**/.env*`, `**/__pycache__/**`).

## Project Discovery & Scoping (`projects` Table)
Within the allowed URI space, the daemon discovers and registers autonomous **Projects**:
- **Git Project:** Any directory containing `.git/`. Forms an atomic boundary with independent Git branch tracking.
- **Non-Git Project:** Standalone local directories with no child `.git/` repositories. Operates under the `$default` branch sentinel.
- **Remote Web Project:** Web URI namespace (e.g. `https://docs.site.com/**`). Operates under `$default` branch with `validUntil` TTL schedules.

## Chokidar Integration & `deny` Lifecycle
When Chokidar or the discovery scanner encounters a path:
1. Normalizes the path to a URI (`file:///...`).
2. Evaluates against `grants`:
   - If `deny`: Chokidar halts directory descent immediately (zero file descriptors allocated, zero events emitted).
   - If `allow`: Chokidar watches and enqueues file events.

### Running `prag deny <uri>` / `prag remove <uri>`
1. Inserts a `deny` rule for `<normalized_uri>/**` into `grants`.
2. Purges any matching project metadata, branch pointers, and chunks from the search index.
3. Notifies the live Chokidar watcher to un-watch the subtree immediately.

## CLI & MCP Interface

### CLI Commands
- `prag watch <uri>`: Adds an `allow` grant for the URI pattern and triggers project discovery.
- `prag deny <uri>`: Adds a `deny` grant, purges any existing index data for that URI, and un-watches the path.
- `prag grants`: Lists active allow and deny rules with patterns and specificity.
- `prag status [uri]`: Displays status of discovered projects, active branches, total chunks, and queue progress.
- `prag projects`: Lists all registered project containers and their root URIs.

### MCP Tools
- `get_indexing_status(uri?: string)`: Checks whether a URI is within an allowed grant and reports project indexing state.
- `watch_uri(uri: string)`: Adds an allow grant and registers project discovery.
- `deny_uri(uri: string)`: Adds a deny grant and purges data for the URI subtree.
