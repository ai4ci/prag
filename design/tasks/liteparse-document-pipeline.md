---
class: task
id: liteparse-document-pipeline.md
title: Implement LiteParse layout-preserving PDF/DOCX to Markdown pipeline
status: todo
priority: medium
relates-to:
  - feature://layout-preserving-chunking.md
---
## Objective
Implement the dedicated layout-preserving document ingestion pipeline for binary documents (PDF, DOCX) using `@llamaindex/liteparse`, per `layout-preserving-chunking.md`.

## Requirements
- Offline layout-aware parsing via `@llamaindex/liteparse`.
- Preserve tables, bullet lists, multi-column blocks, footnotes, and heading hierarchy in the Markdown conversion output.
- Convert extracted pages to clean Markdown prior to chunking and embedding.
- Record `language` in `file_mapping` as the detected document category (e.g. `pdf`, `docx`).
- Define and document a maximum source file size / page count before parsing is skipped or chunked incrementally (open question — see design discussion).