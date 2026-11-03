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

> Status note: partially addressed — see Progress below.

## Acceptance Criteria
- [x] README has a **Getting Started** section that takes a reader from a clean
      machine to a real search result, including OS/Node prerequisites, why native
      addons are involved, and where data lands by default (`resource:env-and-storage-paths.md`).
- [ ] The command sequence in that section is executed by a test or CI job against a real
      installed artifact. `packages/cli/test/subprocess-e2e.test.ts` now runs the CLI as a child
      process against a spawned daemon through `packages/cli/bin/prag.mjs` (what
      `node_modules/.bin/prag` links to), but no CI job runs it — `.github/` is sandbox-protected.
- [x] `prag` is installable by one documented route (`npm install` -> `node_modules/.bin/prag`, or
      `npm link` into a user prefix) and `prag --version` reports the package version. Verified by
      hand: `prag --version` -> `0.1.0`, then daemon start / watch / sync / search-local returned a
      hit for a file in the watched directory.
- [x] `package.json` files declare `engines` (`node >= 22`, root and all three packages).
- [ ] `@prag/cli` `bin` points at built JavaScript, not a `.ts` source file. It now points at
      `bin/prag.mjs`, which is JavaScript, but that wrapper still executes the TS sources through
      the tsx loader; a compiled artifact is `task:toolchain-spike-native-addons.md`. Note:
      `node_modules/.bin/prag` is generated from the lockfile, which is read-only in this sandbox,
      so the link only refreshes once `npm install` can rewrite `package-lock.json` on the host.
- [x] First-run behaviour is stated: model download size and how to avoid it (`fake:<dim>`),
      default port, and where the bearer token comes from.

## Progress (2026-11-02, MVP pass)
`packages/cli/bin/prag.mjs` is the registered executable entry point, `engines: node >= 22` is
declared everywhere, `--version`/`--help` work, and README gained a Getting Started section whose
command sequence was executed by hand from a user npm prefix. Still open: host-side lockfile
regen for the bin link, CI execution of those commands, and a compiled artifact.

## Out of Scope
Binary packaging *choice* (Bun single-file executable vs. published npm package
vs. both) is `task:toolchain-spike-native-addons.md`; this issue is the gap in
documentation and in having any runnable artifact, not the decision about which
distribution format wins.

## Decision 2026-11-03: npm package first, container for the daemon; no single binary

Investigated whether `bun build --compile` could produce a daemon binary that
deploys with no Node or Bun runtime. It can embed `.node` addons, but all three
of this project's native dependencies sit in its documented failure modes:

- An embedded addon is **extracted to a temp file and `dlopen`'d**, so it needs
  a writable `TMPDIR`. On a read-only root filesystem it fails with a
  misleading `/$bunfs/...` path ([oven-sh/bun#45166](https://github.com/oven-sh/bun/issues/45166),
  [#45054](https://github.com/oven-sh/bun/issues/45054)).
- **Only the `.node` file is extracted**, so a sibling shared library it links
  against is not found ([#44063](https://github.com/oven-sh/bun/issues/44063)).
  `onnxruntime-node` ships exactly that shape.
- Embedding needs a **literal, static `require`**; a computed path is not
  discovered at build time. `@kreuzberg/tree-sitter-language-pack` resolves
  grammars by computed path ([WillBooster/tree-sitter#78](https://github.com/WillBooster/tree-sitter/pull/78)
  exists for this case).

`@lancedb/lancedb` is the most likely of the three to work, being a
self-contained Rust NAPI package.

These were read, not reproduced — the dependency shapes match the reports, but
no binary was built. Treat as "documented failure modes matching our
dependency shapes", not a tested result. Node's own SEA is strictly worse here:
it does not bundle native addons at all.

**The deeper point is that a binary would not deliver what it promises.** The
default embedder downloads ~130MB of ONNX weights to a cache on first real
embed, so the artifact would still need network and writable state on first
run. A single binary solves installation, not deployment.

### What to do instead

1. **Publish `@prag/cli` to npm** with a real `bin` entry
   (`packages/cli/bin/prag.mjs`, already correct) and `engines.node`. This is
   what the issue actually asks for and is the cheapest route by a wide margin;
   prebuilt native packages already handle platform resolution.
2. **Ship a container image for the daemon.** It is a long-lived loopback
   service, so a container is its natural unit: it sidesteps every issue above
   and can bake the model weights in so first run works offline.
3. **No single binary.** Revisit only if someone has a deployment target that
   rules out both, and then as a CLI binary (no native dependencies) rather
   than a daemon one.

Scope note: this decision records *what* to ship. Writing the install
documentation, the npm publish workflow and the Dockerfile is the remaining
work, and this issue stays open for it.
