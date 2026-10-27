You should use a single monorepo for prag.
Splitting this into two separate repositories will cause friction because the CLI and the Server (Daemon) must stay perfectly in sync regarding data formats. A monorepo keeps your codebase unified, easy to version, and simple to build locally.

Recommended Monorepo Layout (prag/)

Using a standard workspace framework (like npm/pnpm workspaces or Turbo) allows you to isolate dependencies while sharing crucial TypeScript definitions.
prag/
├── package.json              # Root workspaces configuration
├── turbo.json                # (Optional) Build/Task orchestrator
│
├── packages/
│   ├── core/                 # Shared logic layer
│   │   ├── package.json
│   │   └── src/
│   │       ├── database/     # LanceDB schemas and table connections
│   │       └── interfaces/   # Shared types (SearchQueryOptions, SearchHitResult)
│   │
│   ├── daemon/               # Background Service Engine
│   │   ├── package.json      # Dependencies: tree-sitter-language-pack, @llamaindex/liteparse, chokidar
│   │   └── src/
│   │       ├── queue/        # Ingestion background worker logic
│   │       ├── parsers/      # Router for Tree-sitter & LiteParse
│   │       └── mcp/          # Model Context Protocol stdio host wrapper
│   │
│   └── cli/                  # Command Line Interface Client
│       ├── package.json      # Dependencies: commander / yargs
│       └── src/
│           ├── commands/     # 'search', 'add-project', 'status' handlers
│           └── index.ts      # Binary entry point

Why a Monorepo is the Best Choice for prag


1. Zero-Cost Shared Contracts

The CLI and the Daemon both interact with the exact same LanceDB schemas and metadata shapes. In a monorepo, your packages/core exports single TypeScript definitions that both apps import natively. If you modify a database column in the daemon, the CLI immediately flags a type error at compile time if its query parser breaks. If you used two repos, you would constantly have to publish, update, and track custom npm packages just to share interfaces.

2. Synchronized Versioning and Release

Because prag is a local productivity tool, users expect the CLI and Daemon to upgrade at the exact same moment. Keeping them in one repository ensures that a single git pull or update script grabs the matching executable pairs. This eliminates version-mismatch bugs (e.g., an old CLI binary trying to read a newly updated LanceDB table format created by a newer Daemon).

3. Simplified Local Development

A single repository makes testing the background watcher queue alongside the CLI search client seamless. Developers can run one command to spin up the daemon watcher, make live file changes in a mock repository directory, and instantly execute prag search from the sibling terminal window to verify eventual consistency.
Now that the prag monorepo layout is established, let me know:
• Do you want to define the Shared Core module specification to list the precise types and configuration schemas that both apps will import?
