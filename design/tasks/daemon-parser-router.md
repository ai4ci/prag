---
class: task
id: daemon-parser-router.md
title: Build Tree-sitter and LiteParse parser routing in @prag/daemon
status: in_progress
priority: medium
relates-to:
  - feature:syntax-aware-chunking.md
addressed-by:
  - src:core/src/chunker.ts#chunkFile
  - src:core/src/chunker.ts#detectLanguageFromPath
---
## Description
Implement the parser router in @prag/daemon dispatching code files to Tree-sitter and documents to LiteParse.

## Requirements
- Support Tree-sitter AST parsing for TypeScript, JavaScript, Python, and R.
- Implement structural chunk boundaries on functions, methods, and classes. A chunk is always one whole structural unit and is never split.
- Implement sliding-window **vectorised units** for chunks exceeding `embedding.maxVectorUnitTokens`, with `embedding.vectorUnitOverlapTokens` overlap (ADR-014): emit one `chunk_mapping` row for the chunk and one `vector_pool` row per unit, keyed `(chunkHash, unitIndex)`.
- Prefix each vectorised unit with the chunk's enclosing scope annotation at embedding time only; do not store the prefixed text.
- Implement whitespace normalization for chunkHash calculation over the **whole** chunk regardless of size, while preserving comments and docstrings intact.
- Verify that reformatting code whitespace produces identical chunkHash values, bypassing ONNX re-embedding.
- Route PDF and DOCX files to @llamaindex/liteparse for layout-preserving Markdown extraction.