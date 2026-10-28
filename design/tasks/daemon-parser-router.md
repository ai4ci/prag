---
class: task
id: daemon-parser-router.md
title: Build Tree-sitter and LiteParse parser routing in @prag/daemon
status: todo
priority: medium
relates-to:
  - feature://syntax-aware-chunking.md
---
## Description
Implement the parser router in @prag/daemon dispatching code files to Tree-sitter and documents to LiteParse.

## Requirements
- Support Tree-sitter AST parsing for TypeScript, JavaScript, Python, and R.
- Implement structural chunk boundaries on functions, methods, and classes.
- Implement sliding-window sub-chunking for structural units exceeding `embedding.maxChunkTokens`, with `embedding.chunkOverlapTokens` overlap (ADR-014).
- Implement whitespace normalization for chunkHash calculation while preserving comments and docstrings intact.
- Verify that reformatting code whitespace produces identical chunkHash values, bypassing ONNX re-embedding.
- Route PDF and DOCX files to @llamaindex/liteparse for layout-preserving Markdown extraction.