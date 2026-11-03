---
class: task
id: liteparse-document-pipeline.md
title: Implement LiteParse layout-preserving PDF/DOCX to Markdown pipeline
status: blocked
priority: medium
relates-to:
  - feature:layout-preserving-chunking.md
---
## Objective
Implement the dedicated layout-preserving document ingestion pipeline for binary documents (PDF, DOCX) using `@llamaindex/liteparse`, per `layout-preserving-chunking.md`.

## Requirements
- Offline layout-aware parsing via `@llamaindex/liteparse`.
- Preserve tables, bullet lists, multi-column blocks, footnotes, and heading hierarchy in the Markdown conversion output.
- Convert extracted pages to clean Markdown prior to chunking and embedding.
- Record `language` in `file_mapping` as the detected document category (e.g. `pdf`, `docx`).
- Define and document a maximum source file size / page count before parsing is skipped or chunked incrementally (open question — see design discussion).

## Parked 2026-11-03: cannot add the dependency from here

`@llamaindex/liteparse` is not installed and is in no `package.json`. Adding
it needs a `package-lock.json` change, and the lockfile is read-only in the
development sandbox (`.sandbox` baseline protects npm lockfiles), so the
dependency cannot be added from an agent session.

**Action for the maintainer:** `npm i -w @prag/daemon @llamaindex/liteparse`
on the host, then this task is unblocked and self-contained -- routing PDF and
DOCX to it, and the fixture documents (`test/fixtures/documents/sample.pdf`,
`sample.docx`) already exist to test against.

Worth deciding at the same time: liteparse pulls its own native/WASM payload,
which bears on `issue:no-installation-instructions.md` (install size) and on
ADR-020's native-addon surface. Nothing else here is blocked on that question.
