---
class: task
id: deterministic-embedding-provider.md
title: Implement injectable fake embedding provider (fake:<dim>)
status: todo
priority: high
relates-to:
  - feature://test-harness-and-fixtures.md
blocks:
  - task://test-harness-lifecycle.md
addressed-by:
  - src://core/src/embedding.ts#FakeEmbeddingProvider
  - src://core/src/embedding.ts#EmbeddingProvider
  - src://core/src/embedding.ts#EmbeddingSidecar
  - src://core/src/embedding.ts#registerProvider
  - src://core/src/embedding.ts#getProvider
  - src://core/src/embedding.ts#parseFakeDim
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
- A full index-and-search cycle with `fake:384` makes zero outbound network connections and loads no model file. This is what makes `air-gap-hardware-provider.md`'s zero-connection assertion satisfiable on a cold machine.
- Starting the daemon with `fake:384` against an index pinned to a real model fails with the ADR-015 mismatch error, and vice versa.
