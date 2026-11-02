---
class: issue
id: no-installation-instructions.md
title: No installation instructions or installable artifact
status: open
priority: medium
relates-to:
  - feature:dual-interfaces.md
---
## Problem
There is no documented way to install `prag`, and no artifact to install. The
README jumps from an architectural overview to `prag daemon start` (README.md:68-84)
without ever saying how `prag` got onto the PATH, what it needs to run, or where
its data will live. A new user cannot get from `git clone` to a working `prag
search-local` without reading the monorepo layout and guessing.

Concretely, as of `4906660`:

- **No prerequisites stated.** Native addons (`@lancedb/lance`, tree-sitter
  grammars) pin the usable Node range; ONNX model weights (~130MB, ADR-006) are
  downloaded on first real embed; both are invisible to a reader. No `engines`
  field exists in any `package.json`.
- **Nothing is executable.** `@prag/cli` declares
  `"bin": { "prag": "./src/main.ts" }` (`packages/cli/package.json`) with a
  `#!/usr/bin/env node` shebang on a **TypeScript** file. Node cannot load it;
  the CLI only works today because tests invoke `main.ts` through `tsx`
  in-process.
- **No build or packackage output.** Root `npm run build` runs only
  `npm -w @prag/core run build`; the daemon and CLI have no build script
  (`packages/daemon/package.json`, `packages/cli/package.json`), and no
  `prepublish`/`files`/dist configuration anywhere.
- **Not publishable.** Root and `@prag/cli` are `"private": true`; there is no
  release, tag, or packaging path, so `npm i -g prag` and `npm i -g .` both fail.
- **No install path is documented even for the source-only case** — the
  `npm install` + `npx tsx packages/cli/src/main.ts …` incantation that actually
  works today is nowhere written down, nor is the `PRAG_*` environment setup a
  user needs before first run (`PRAG_ROOT` isolation, `PRAG_API_KEY`,
  `PRAG_EMBEDDING_MODEL=fake:384` for a model-free smoke test).

This blocks the client SDK work in `feature:client-sdks.md`: "add prag to my
project" has no answer until there is something to add.

## Acceptance Criteria
- README has a **Getting Started** section that takes a reader from a clean
  machine to a real search result, including OS/Node prerequisites, why native
  addons are involved, and where data lands by default (`resource:env-and-storage-paths.md`).
- The command sequence in that section is executed by a test or CI job against a
  real installed artifact, so the instructions cannot silently rot.
- `prag` is installable by at least one documented route (global install from a
  published package, or a packaged single-binary build) and `prag --version`
  reports the package version.
- `package.json` files declare `engines`, and an unsupported Node version fails
  with a message naming the required range instead of a native-addon load error.
- `@prag/cli` `bin` points at built JavaScript, not a `.ts` source file.
- First-run behaviour is stated: model download size and how to avoid it
  (`fake:<dim>`), default port, and where the bearer token comes from.

## Out of Scope
Binary packaging *choice* (Bun single-file executable vs. published npm package
vs. both) is `task:toolchain-spike-native-addons.md`; this issue is the gap in
documentation and in having any runnable artifact, not the decision about which
distribution format wins.
