---
class: feature
id: multi-format-parsing.md
title: Multi-Format Code and Document Parsing
status: in_progress
priority: high
area: ingestion
guided-by:
  - adr:ADR-003.md
---
## Overview
The system must process structured programming source code files (`.ts`, `.js`, `.py`, `.r`, etc.), prose markdown (`.md`, `.txt`), and rich text/binary layout documents (`.pdf`, `.docx`).

## Requirements
- Multi-language AST parsing for code files via Tree-sitter.
- Binary document layout extraction via LiteParse.
- Automatic language detection based on file extensions and contents, recording the `language` column in `file_mapping`.
- Clean Markdown extraction from binary layouts preserving hierarchy.