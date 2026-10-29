---
title: Indexing Sample Document
---

# Indexing Sample Document

This document exists so that the PDF and DOCX parsers can be tested against a
source whose text is already known. The `.pdf` and `.docx` beside it are
generated from this file, so all three should extract to the same prose.

## Why it matters

- Extraction must preserve heading text, not just body paragraphs.
- List items must stay separate lines rather than running together.
- Tables must survive as rows, even if the cell borders are lost.

## Supported formats

| Format | Parser    | Notes                                  |
| ------ | --------- | -------------------------------------- |
| Markdown | LiteParse | the source of truth for this fixture |
| PDF    | LiteParse | generated with pandoc                  |
| DOCX   | LiteParse | generated with pandoc                  |

A closing paragraph, so that the last section is not a bare table.
