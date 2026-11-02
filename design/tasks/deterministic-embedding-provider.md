---
class: task
id: deterministic-embedding-provider.md
title: Implement injectable fake embedding provider (fake:<dim>)
status: in_progress
priority: high
relates-to:
  - feature:test-harness-and-fixtures.md
blocks:
  - task:test-harness-lifecycle.md
addressed-by:
  - src:core/src/embedding.ts#FakeEmbeddingProvider
  - src:core/src/embedding.ts#EmbeddingProvider
  - src:core/src/embedding.ts#EmbeddingSidecar
  - src:core/src/embedding.ts#registerProvider
  - src:core/src/embedding.ts#getProvider
  - src:core/src/embedding.ts#parseFakeDim
tested-by:
  - daemontest:fake-provider-entry.test.ts#fakeProviderEntryPointSuite
  - coretest:paths.test.ts#loadPragConfigSuite
  - coretest:embedding.test.ts#fakeEmbeddingProviderSuite
  - coretest:embedding.test.ts#getProviderRegisterProviderSuite
  - coretest:embedding.test.ts#parseFakeDimSuite
---
## Objective
Give the embedding pipeline a seam so tests can run offline, instantly, and deterministically (ADR-019). Without it every test that indexes anything needs ~130MB of ONNX weights (ADR-006), pays model-load time, and asserts against ranking that moves between model revisions.

## Requirements
- Accept `PRAG_EMBEDDING_MODEL=fake:<dim>` (e.g. `fake:384`) and `embedding.model: "fake:384"` in `config.json`, selecting a built-in provider in `@prag/core` behind the same interface as the ONNX provider.
- The fake embedder derives the vector deterministically from a hash of the input text. Same text in, same vector out, on every machine and every run. No network, no filesystem, no model load.
- It is **not** semantically meaningful and must not pretend to be. Document that it is for plumbing assertions only.
- Pin it in the ADR-015 sidecar exactly like a real model (`{ model: "fake:384", dim: 384, ... }`), so switching between the fake and a real model is caught by the existing mismatch gate instead of silently mixing two embedding spaces.
- Ship it in production code, not test-only code: it is reachable by a user who configures it explicitly, which is acceptable and useful for smoke-testing an install with no model download.
- `embedding.maxVectorUnitTokens` validation (ADR-014) still applies: the fake provider declares a maximum sequence length so the startup check has something to validate against.

## Verification
- Indexing the same fixture twice with `fake:384` produces identical `chunkHash` and identical vectors.
- A full index-and-search cycle with `fake:384` makes zero outbound network connections and loads no model file. This is what makes `local-first-enforcement.md`'s zero-connection assertion satisfiable on a cold machine.
- Starting the daemon with `fake:384` against an index pinned to a real model fails with the ADR-015 mismatch error, and vice versa.

## Implementation status

Complete. The provider was always correct; what was missing was that **nothing in
production could reach it**, and the reason was a defect larger than this task.

- **Config/env selection — done.** `loadPragConfig()` (`packages/core/src/paths.ts`) called
  `require("node:fs")` inside a `try { … } catch { return {} }`. This is an ESM package, so
  `require` is undefined: **every** `config.json` read threw, was swallowed, and returned `{}`.
  `embedding.model` — and the port, pool size, thresholds and every other setting in that file —
  had never had any effect, with no symptom anywhere. It now imports `fs` normally, and a
  malformed `config.json` throws rather than being swallowed too: starting on the wrong model
  because of a stray comma is worse than failing loudly. `loadConfig()` maps
  `PRAG_EMBEDDING_MODEL` over the file value and `bootstrap()` resolves the result.
- **Registry precedence — done.** `getProvider()` returned the first prefix match in insertion
  order, so `registerProvider("onnx:Xenova/bge-small-en-v1.5", …)` lost to the built-in `onnx:`
  factory. Longest prefix now wins, which is what makes the documented extension point usable
  for a single model.
- **Sidecar pinning — done.** `bootstrap()` writes `.embedding-model.json`
  (`readEmbeddingSidecar`/`writeEmbeddingSidecar`) with the same fields for `fake:64` as for a
  real model, and refuses a mismatch. The check runs **before** `provider.load()`, so a doomed
  start does not first download 130MB of weights for a daemon that will refuse to serve them.

## Verification (all three requirements executed)

`packages/daemon/test/fake-provider-entry.test.ts` goes through `loadConfig()`/`bootstrap()`
rather than constructing the provider, so it would have caught the swallowed `require`:

- Both documented knobs select the provider, env overriding the file.
- Identical hashes **and vectors** across two independent daemons with two fresh databases.
  `chunkHash` is a content hash, so the vectors are the claim being made.
- Zero outbound connections over a real index-and-search cycle. Patched on `Socket.prototype`,
  not the `net` module: ESM namespace objects are sealed, and undici reaches TCP through that
  one method. Loopback to the daemon under test is allowed; anything else fails the test.
- Mismatch refused fake→real and real→fake, with the `prag reembed` remedy in the message, and
  the gate proven to fire before `load()`.
