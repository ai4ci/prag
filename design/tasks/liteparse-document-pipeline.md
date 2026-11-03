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

## Unblocked 2026-11-03: dependency installed, and a rival to decide between

`@llamaindex/liteparse` 2.17.0 is installed in `@prag/daemon` and works. The
maintainer also installed `@xberg-io/xberg` 1.3.10, asking whether it should
replace LiteParse. Both were run against this task's own fixtures
(`test/fixtures/documents/sample.pdf`, `sample.docx`) rather than compared on
documentation. **Neither one wins outright**, which is the finding.

### Measured

| | LiteParse | xberg |
|---|---|---|
| PDF -> Markdown | 5ms; `#`/`##` headings, `-` bullets, a real table | 12ms; **flat** -- no headings, bullets run into one paragraph, table flattened to prose, `tables: 0` |
| DOCX -> Markdown | **444ms** (1478ms first call); full structure | **2ms**; full structure, identical output |
| HTML -> Markdown | not supported | native, offline, with tables and code fences |
| Formats | PDF, plus others via conversion | 141 by extension |
| Source code | no | Tree-sitter: `kind`, `name`, `signature`, `doc_comment`, byte spans, nested children, for TypeScript, Python **and R** |
| Install | 33MB (`.node` + `libpdfium.so`) | 125MB (`.node` + `libonnxruntime`, `libheif`, `libaom`, `libde265`) |

Two results drive the conclusion. **On PDF, LiteParse is clearly better**: it
reconstructs heading levels, list bullets and table structure from page
geometry, and xberg's native engine returns flat prose. (xberg's PDF
`hierarchy` extraction is off by default; enabling it did not close the gap.)
**On DOCX, xberg is better and ~200x faster**: LiteParse converts DOCX by
rendering it to pages and re-deriving layout, which is the wrong shape for a
format that carries its structure explicitly.

### Recommendation: both, routed by format

Route PDF to LiteParse, everything else to xberg. This is not fence-sitting --
the two tools are doing different jobs. LiteParse is a page-geometry engine
and PDF is the only format where geometry is all there is. xberg is a
format-aware extractor and is better wherever the structure is already in the
file.

That makes `daemon-parser-router`'s scope depend on the answer, which is why
it has not been implemented ahead of a decision: with LiteParse alone the
refusal set in `UNSUPPORTED_DOCUMENT_EXTENSIONS` shrinks by two entries; with
xberg it shrinks by a few dozen (`.pptx`, `.xlsx`, `.epub`, `.odt`, `.rtf`,
images via OCR). Building the router against one and then widening it to the
other is the waste worth avoiding. The seam itself is the same either way: one
function from bytes plus filename to Markdown.

### Two things to settle at the same time

**Local-first.** `xberg.doctor()` reports several optional models as "model
not cached locally; first use may download it" (layout detection, table
structure, formula OCR). They are opt-in and none is on the default path, but
the daemon must pin them off explicitly rather than rely on that, the same way
`crawlberg`'s SSRF policy is pinned in ADR-024. `feature:local-first-runtime.md`
is the binding requirement.

**ADR-003 says "LiteParse" by name** and would need amending for either
outcome -- its reasoning ("LiteParse converts rich text directly into cleanly
structured local Markdown strings") is correct for PDF and is what the DOCX
measurement contradicts.

### Not a Tree-sitter replacement

xberg's code intelligence overlaps `core/src/chunker.ts` and looks tempting,
but it got **R function names wrong** in the spike: `greet <- function(name)`
reported as `name: "function"` rather than `greet`, for both functions in the
fixture. R assigns functions to variables and xberg's extractor does not
resolve the assignment. R is the language ADR-003 was written around, so this
is not a corner case here. The code path stays with the existing chunker.
