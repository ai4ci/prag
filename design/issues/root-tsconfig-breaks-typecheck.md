---
class: issue
id: root-tsconfig-breaks-typecheck.md
title: Root npm run lint cannot run — tsc --noEmit fails TS6059 rootDir for every package file
status: resolved
priority: medium
---
## Problem
`package.json:9` defines `"lint": "tsc --noEmit"`, but the root `tsconfig.json:12` sets
`rootDir: "${configDir}/src"`, which no package satisfies. Running `npm run lint` emits
`error TS6059: File '/home/vp22681/Git/prag/packages/cli/src/index.ts' is not under
'rootDir' ...` for **every** file in every package. The check fails identically on a clean
tree, so the repo's own typecheck gate proves nothing and is silently ignored.

This matters beyond noise: several open tasks (`task:error-contract.md`,
`task:search-project-scoping.md`) require signature changes across all three packages, and
`tsc --noEmit` is exactly the tool that would catch the fallout at the boundary. Today a
cross-package type error — e.g. adding a `projectId` parameter to `hybridSearch()` and
missing a caller — is invisible until runtime.

## Expected Behaviour
`npm run lint` type-checks all three packages, or the script is removed so nobody assumes a
typecheck ran. Prefer a solution that reuses the per-package configs already present
(`packages/*/tsconfig.json`, plus `packages/core/tsconfig.build.json`) rather than a fourth
config.

## Acceptance Criteria
- `npm run lint` exits 0 on a clean tree.
- Introducing a deliberate type error in one package makes `npm run lint` fail naming that
  file.
- The CI workflow that `task:test-fixture-corpus.md` needs for `check-invariants.ts` runs
  `npm run lint` and `npm test`, so the gate stays honest.

## Related
Interacts with `issue:no-installation-instructions.md` (the same broken-package.json area:
`private: true` everywhere, `bin` pointing at raw TypeScript) and with the missing
`.github/workflows/ci.yaml`, which is tracked as a Pi todo because `.github/` is
sandbox-protected and cannot be created from inside the sandbox.

## Resolution (2026-11-02, branch `mvp`) — workaround, root cause still open
`npm run lint` (root `tsc --noEmit`) still fails TS6059 for every package file, so the repo has no
working whole-tree typecheck. Added `packages/daemon/tsconfig.check.json` (no `noUnusedLocals`,
`include` pulls in core + cli sources) and a root `npm run typecheck` script that uses it; it
covers all three packages transitively and is what CI should call until the root config is fixed.
