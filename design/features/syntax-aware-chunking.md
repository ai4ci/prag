---
class: feature
id: syntax-aware-chunking.md
title: Syntax-Aware Structural Code Chunking and Whitespace Normalization
status: in_progress
priority: high
area: ingestion
guided-by:
  - adr:ADR-003.md
  - adr:ADR-010.md
  - adr:ADR-014.md
implemented-by:
  - src:core/src/chunker.ts#chunkFile
  - src:core/src/chunker.ts#normalizeWhitespace
  - src:core/src/chunker.ts#chunkHash
  - src:core/src/chunker.ts#fallbackChunk
  - src:core/src/chunker.ts#buildScopeTree
  - src:core/src/chunker.ts#findScopePath
  - src:core/src/chunker.ts#Chunk
  - src:core/src/chunker.ts#ChunkedFile
---
## Overview
Source code must be partitioned along structural semantic boundaries (e.g. classes, functions, methods) utilizing Tree-sitter grammar definitions to preserve contextual integrity. To insulate the retrieval index from cosmetic formatting changes (linters, Prettier, Black), chunk hashing uses structural whitespace normalization while retaining comments.

## Structural Partitioning
- **Tree-sitter AST Boundaries:** Identify primary structural units (`function_definition`, `class_declaration`, `method_definition`, `impl_item`).
- **Lexical Context Management:** Preserve enclosing namespace, class name, and parent scope metadata prepended or annotated in chunk text so chunks retain context in vector space.

## Vectorised Units for Oversized Chunks (ADR-014)
A **chunk** is always one whole structural unit and is never split. When a chunk exceeds what the embedding model can consume, it is *vectorised* in sliding windows instead:
- A **vectorised unit** is a sliding token window over one chunk, sized by `embedding.maxVectorUnitTokens` (default 400, measured with the active model's tokenizer) with `embedding.vectorUnitOverlapTokens` overlap (default 60). A chunk yields 1..* units; exactly one when it already fits.
- `chunk_mapping` is unaffected: still one row per structural unit, whatever its size.
- `chunkHash` covers the whole chunk regardless of size, so dedup via `chunks_pool` works identically for large and small units.
- Each vectorised unit carries the chunk's enclosing namespace/class/parent-scope annotation as an embedding-time prefix, so a window from the middle of a large function stays meaningful in vector space. The prefix is not stored.
- Vectors live in `vector_pool` keyed by `(chunkHash, unitIndex)`. Dense search collapses to the best-scoring unit per chunk, so a large function surfaces once rather than once per window.
- The daemon refuses to start if `maxVectorUnitTokens` exceeds the active model's reported maximum sequence length, so a config change cannot silently reintroduce truncation.

## Whitespace Normalization & Hashing Rules
1. **Retain Comments:** Comments, docstrings, and type annotations are preserved verbatim inside the chunk text and contribute to the dense embedding.
2. **Whitespace Normalization for `chunkHash`:**
   - Normalize line breaks (`\r\n` -> `\n`).
   - Strip trailing spaces from all lines and trim outer blank lines.
   - Collapse meaningless interior whitespace sequences while preserving semantic indentation (e.g. Python indentation derived from the AST).
3. **Reformatting Invariance:**
   - If a linter or formatter rewrites a file without altering code or comments, the normalized chunk strings produce identical SHA-1 `chunkHash` values.
   - The daemon finds existing chunks in `chunks_pool`, bypassing expensive ONNX embedding calculations.
