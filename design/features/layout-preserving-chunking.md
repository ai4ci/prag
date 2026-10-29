---
class: feature
id: layout-preserving-chunking.md
title: Layout-Preserving Document Chunking
status: accepted
priority: medium
area: ingestion
guided-by:
  - adr://ADR-003.md
  - adr://ADR-014.md
---
## Overview
Binary documentation layouts (such as PDFs and DOCX) must be decomposed offline while preserving tables, lists, headers, and relative section hierarchy.

## Requirements
- Offline layout-aware parsing using `@llamaindex/liteparse`.
- Preservation of tabular layouts, bullet lists, multi-column blocks, footnotes, and heading structures.
- Convert extracted pages into clean Markdown representation prior to chunking and vector embedding.
- A layout block is a chunk and is never split: an oversized block (a long table or section) is embedded as several sliding-window **vectorised units** under one `chunkHash`, exactly as for code (ADR-014), so it is still returned whole.