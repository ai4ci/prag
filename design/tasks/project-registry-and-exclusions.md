---
class: task
id: project-registry-and-exclusions.md
title: Implement grants and projects tables with allow/deny evaluation and Chokidar filter integration
status: todo
priority: high
relates-to:
  - feature://project-registry-and-status.md
---
## Description
Implement the `grants` and `projects` tables in LanceDB, along with allow/deny evaluation and Chokidar watcher filter integration.

## Requirements
- Define LanceDB schemas for `grants` and `projects` in `@prag/core`.
- Implement allow/deny evaluation engine: longest-prefix match, deny by default, deny breaks ties, and built-in vendor ignores.
- Implement URI normalization helper (`file:///...` and `https://...`).
- Integrate grant evaluation into Chokidar file watcher: evaluate directory paths before descending, halting descent immediately on `deny`.
- Implement project discovery: scan allowed URI space, detecting atomic Git repositories and registering them into `projects`.
- Implement CLI commands `prag watch <uri>`, `prag deny <uri>`, `prag grants`, and `prag status`.
- Expose MCP tools `get_indexing_status`, `watch_uri`, and `deny_uri`.