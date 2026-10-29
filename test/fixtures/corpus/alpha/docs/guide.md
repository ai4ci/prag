# Alpha indexing guide

Alpha is a small example project. This guide describes how its sources are
laid out and how the indexer is expected to treat them.

## Layout

- `src/` holds the library code, in TypeScript, Python and R.
- `docs/` holds prose, which is chunked by layout rather than by syntax.
- Generated output is never committed.

## Running an index

Point the daemon at the checkout and let it walk the working tree:

```bash
prag add ./alpha --name alpha
prag status --name alpha
```

### Chunking behaviour

| File            | Parser      | Expected units                     |
| --------------- | ----------- | ---------------------------------- |
| `src/math.ts`   | Tree-sitter | one chunk per exported function    |
| `src/large.ts`  | Tree-sitter | one chunk, several vectorised units |
| `src/stats.R`   | Tree-sitter | one chunk per function, roxygen kept |
| `docs/guide.md` | LiteParse   | one chunk per section              |

### Caveats

Headings are kept with the body that follows them, so a section shorter than
the chunk budget stays whole.
