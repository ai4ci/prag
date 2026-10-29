# Test fixtures

Static inputs for the indexer tests. Nothing here is generated at test time
except the git repositories, which are built by `build-git-fixtures.mjs`.

## Fixture index

| Path | Proves | Invariant to preserve |
| --- | --- | --- |
| `corpus/alpha/src/math.ts` | Tree-sitter TypeScript chunking: one chunk per exported function, JSDoc kept with its function | each function must stay comfortably under the 400-token chunk budget |
| `corpus/alpha/src/large.ts` | an AST node larger than the chunk budget becomes several overlapping vectorised units under **one** chunk hash | exactly one exported function; its body must stay well over 400 tokens (currently ~6.2k characters). Do not split it up |
| `corpus/alpha/src/shared.ts` | cross-project content-addressable dedup: the same content indexed from two projects shares one `chunks_pool` row | must stay **byte-identical** to `corpus/beta/src/shared.ts` (`cmp` the two after any edit) |
| `corpus/beta/src/shared.ts` | the other half of the dedup pair | as above — edit both or neither |
| `corpus/alpha/src/analysis.py` | Tree-sitter Python chunking: class, methods and module function with docstrings | keep the class, its two methods and the module-level `summarise` |
| `corpus/alpha/src/stats.R` | Tree-sitter R chunking with roxygen `#'` comments attached to their function | keep the roxygen blocks; this file is deleted on `feature-x`, so tests assert it is absent there |
| `corpus/alpha/docs/guide.md` | layout-preserving markdown chunking | must keep ≥2 heading levels, a bullet list, a fenced code block and a table |
| `corpus/alpha-feature-x/src/analysis.py` | a second version of an existing path on a branch (new `quantile` method, changed `summarise` body) | same path as alpha's (`src/analysis.py`) and genuinely different content |
| `corpus/alpha-feature-x/src/new-feature.ts` | a file that exists only on `feature-x` | must not appear anywhere under `corpus/alpha/` |
| `corpus/beta/src/only-beta.ts` | a file unique to the beta project | must not appear in alpha |
| `corpus/plain/notes.md`, `corpus/plain/script.py` | indexing a directory with no git metadata, recorded against the `$default` branch sentinel | the built `plain` directory must never contain a `.git` |
| `corpus/reformat/original.ts` | whitespace-normalized hashing baseline | — |
| `corpus/reformat/reformatted.ts` | reformatting alone does not change a chunk hash | must differ from `original.ts` **only** in whitespace. Check with `diff <(tr -d '[:space:]' < original.ts) <(tr -d '[:space:]' < reformatted.ts)` — no output |
| `documents/sample.md` | source of truth for the document fixtures | if edited, regenerate the `.pdf` and `.docx` (see below) |
| `documents/sample.pdf`, `documents/sample.docx` | LiteParse PDF/DOCX extraction | generated from `sample.md`; all three should extract to the same prose |
| `web/firecrawl-stub.json` | web ingestion with zero outbound network calls — a stub HTTP server returns this body | keep the `url`, `markdown`, `html` and `metadata.{title,description,statusCode}` fields |

## Building the git fixtures

```bash
node test/fixtures/build-git-fixtures.mjs /tmp/prag-fixtures
```

The script wipes and recreates the target directory, so it is idempotent and
safe to run from a test `beforeAll`. On success it prints exactly one line of
JSON to stdout and nothing else:

```json
{"alpha":"/tmp/prag-fixtures/alpha","beta":"/tmp/prag-fixtures/beta","plain":"/tmp/prag-fixtures/plain"}
```

On any failure it writes a message to stderr and exits non-zero.

What it produces:

- **`alpha/`** — a git repo with two branches.
  - `main`: one commit containing all of `corpus/alpha/`.
  - `feature-x`: a second commit that overwrites `src/analysis.py`, adds
    `src/new-feature.ts` and `git rm`s `src/stats.R`.
  - `main` is checked out when the script finishes.
  - Untracked exclusion noise written *after* the commits, so it is never in
    history: `.env` (a fake-looking secret) and `node_modules/junk/index.js`.
    Tests assert the built-in ignore rules skip both.
- **`beta/`** — a git repo, one commit on `main`, from `corpus/beta/`.
- **`plain/`** — a plain directory from `corpus/plain/`, with no git repo.

Commits are deterministic: fixed author/committer identity
(`Prag Fixture <fixtures@prag.invalid>`), fixed `GIT_AUTHOR_DATE` /
`GIT_COMMITTER_DATE`, global and system git config neutralised, and signing
disabled. The same SHAs come out of every build, so tests may assert on them:

| Repo | Ref | SHA |
| --- | --- | --- |
| alpha | `main` | `2f66f6be9cc56324c390f54786fa7c1b4b53dc68` |
| alpha | `feature-x` | `c23bf43043d1a834774337d9824f6e9b38b9c61b` |
| beta | `main` | `a92bc1b54bcc2358305c12698abfa1d6c2a13259` |

Editing anything under `corpus/alpha/` or `corpus/beta/` changes these SHAs —
update the table when that happens.

## Regenerating the document fixtures

```bash
cd test/fixtures/documents
pandoc sample.md -o sample.docx
libreoffice --headless --convert-to pdf sample.docx --outdir .
```

`pandoc sample.md -o sample.pdf` is the obvious route but needs a working
LaTeX engine; the LibreOffice conversion of the `.docx` is the fallback used
here. Either way, verify with `file sample.pdf sample.docx`.
