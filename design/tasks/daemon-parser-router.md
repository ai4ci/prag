---
class: task
id: daemon-parser-router.md
title: Build Tree-sitter and LiteParse parser routing in @prag/daemon
status: done
priority: medium
relates-to:
  - feature:syntax-aware-chunking.md
addressed-by:
  - src:core/src/chunker.ts#chunkFile
  - src:core/src/chunker.ts#detectLanguageFromPath
tested-by:
  - coretest:chunker.test.ts#detectLanguageFromPathSuite
  - coretest:chunker.test.ts#chunkFileSuite
  - coretest:chunker.test.ts#normalizeWhitespaceSuite
  - coretest:chunker.test.ts#chunkHashSuite
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

## Implementation status 2026-11-03

Every requirement is met except document routing, which is blocked on a
dependency that cannot be added from here.

- **Tree-sitter for TypeScript, JavaScript, Python and R — DONE.**
- **Structural chunk boundaries, never splitting a unit — DONE.**
- **ADR-014 vectorised units with overlap, one `chunk_mapping` row per chunk
  and one `vector_pool` row per unit keyed `(chunkHash, unitIndex)` — DONE.**
- **Scope annotation prefixed at embedding time only, not stored — DONE.**
- **ADR-010 whitespace normalisation over the whole chunk, comments preserved,
  verified by the `reformat` fixture pair — DONE.**
- **PDF/DOCX routing to LiteParse — BLOCKED.** See
  `task:liteparse-document-pipeline.md`: the package is not installed and the
  lockfile is read-only in the development sandbox. Unsupported documents are
  refused by extension today, which is the correct interim behaviour --
  nothing is silently indexed as garbage.


## Closed 2026-11-03: document routing implemented

The one outstanding requirement -- "Route PDF and DOCX files to
@llamaindex/liteparse for layout-preserving Markdown extraction" -- is done,
and widened: PDF goes to LiteParse, and DOCX along with every other format in
`DOCUMENT_FORMATS` goes to xberg, per the ADR-003 amendment. The interim
behaviour this task recorded ("unsupported documents are refused by
extension") now applies only to archives, images and compiled artefacts --
things with no text to extract rather than things prag had not got round to.
