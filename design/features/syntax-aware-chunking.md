---
class: feature
id: syntax-aware-chunking.md
title: Syntax-Aware Structural Code Chunking and Whitespace Normalization
status: accepted
priority: high
area: ingestion
guided-by:
  - adr://ADR-003.md
  - adr://ADR-010.md
  - adr://ADR-014.md
---
## Overview
Source code must be partitioned along structural semantic boundaries (e.g. classes, functions, methods) utilizing Tree-sitter grammar definitions to preserve contextual integrity. To insulate the retrieval index from cosmetic formatting changes (linters, Prettier, Black), chunk hashing uses structural whitespace normalization while retaining comments.

## Structural Partitioning
- **Tree-sitter AST Boundaries:** Identify primary structural units (`function_definition`, `class_declaration`, `method_definition`, `impl_item`).
- **Lexical Context Management:** Preserve enclosing namespace, class name, and parent scope metadata prepended or annotated in chunk text so chunks retain context in vector space.

## Oversized Node Sub-Chunking (ADR-014)
Structural units exceeding `embedding.maxChunkTokens` (default 400 tokens, measured with the active model's tokenizer) are split into sequential sliding-window sub-chunks with `embedding.chunkOverlapTokens` overlap (default 60):
- Each sub-chunk is its own `chunk_mapping` row, sharing the parent `fileVersionId` and occupying consecutive `chunkIndex` values.
- Each sub-chunk retains the same enclosing namespace/class/parent-scope annotation as an ordinary chunk.
- `chunkHash` is computed per sub-chunk; identical sub-chunks dedupe normally via `chunks_pool`.
- Units at or under the limit are emitted as a single chunk, unaffected.

## Whitespace Normalization & Hashing Rules
1. **Retain Comments:** Comments, docstrings, and type annotations are preserved verbatim inside the chunk text and contribute to the dense embedding.
2. **Whitespace Normalization for `chunkHash`:**
   - Normalize line breaks (`\r\n` -> `\n`).
   - Strip trailing spaces from all lines and trim outer blank lines.
   - Collapse meaningless interior whitespace sequences while preserving semantic indentation (e.g. Python indentation derived from the AST).
3. **Reformatting Invariance:**
   - If a linter or formatter rewrites a file without altering code or comments, the normalized chunk strings produce identical SHA-1 `chunkHash` values.
   - The daemon finds existing chunks in `chunks_pool`, bypassing expensive ONNX embedding calculations.
