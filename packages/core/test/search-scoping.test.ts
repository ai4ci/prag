// Project + branch scoping through the real schema (LanceDbSchema, real tables,
// real primary keys) rather than hand-rolled tables: the behaviour under test is
// how a chunk shared by two projects resolves back to two file versions, which
// depends on chunk_mapping's composite key and branch_mapping's merge key.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { LanceDbSchema } from "../src/database.js";
import {
  upsertFileMapping,
  upsertChunkMapping,
  upsertChunksPool,
  upsertVectorPool,
  upsertBranchMapping,
} from "../src/database.js";
import { FakeEmbeddingProvider } from "../src/embedding.js";
import { hybridSearch } from "../src/search.js";
import { DEFAULT_BRANCH } from "../src/branch.js";

const DIM = 64;
const embedder = new FakeEmbeddingProvider(DIM);

/** One indexed file version whose single chunk is `text`. */
async function indexFile(
  db: LanceDbSchema,
  opts: {
    fileVersionId: string;
    projectId: string;
    uri: string;
    text: string;
  },
): Promise<string> {
  const contentHash = `h-${opts.fileVersionId}`;
  const chunkHash = `c-${hash(opts.text)}`;

  await upsertChunksPool(db.table("chunks_pool"), [
    { chunkHash, text: opts.text, scopeContext: null },
  ]);
  const [vector] = await embedder.embedBatch([opts.text]);
  await upsertVectorPool(db.table("vector_pool"), [
    { chunkHash, unitIndex: 0, vector },
  ]);
  await upsertFileMapping(db.table("file_mapping"), [
    {
      fileVersionId: opts.fileVersionId,
      projectId: opts.projectId,
      uri: opts.uri,
      validUntil: null,
      contentHash,
      language: "typescript",
    },
  ]);
  await upsertChunkMapping(db.table("chunk_mapping"), [
    { fileVersionId: opts.fileVersionId, chunkIndex: 0, chunkHash },
  ]);
  return contentHash;
}

/** Stable short hash, so identical text yields one pool row (CAS as in production). */
function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

async function point(
  db: LanceDbSchema,
  branch: string,
  projectId: string,
  uri: string,
  fileVersionId: string,
): Promise<void> {
  await upsertBranchMapping(db.table("branch_mapping"), [
    { branch, projectId, uri, fileVersionId, updatedAt: new Date() },
  ]);
}

function search(
  db: LanceDbSchema,
  query: string,
  options: Parameters<typeof hybridSearch>[8],
) {
  return hybridSearch(
    db.table("chunks_pool"),
    db.table("vector_pool"),
    db.table("chunk_mapping"),
    db.table("file_mapping"),
    embedder,
    query,
    5,
    50,
    options,
  );
}

function scopingSuite(): void {
  let tmpDir: string;
  let db: LanceDbSchema;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "prag-scoping-"));
    db = new LanceDbSchema({ dbPath: tmpDir, embeddingDim: DIM });
    await db.init();

    // Two projects, one byte-identical file: one chunks_pool row, two file versions.
    const shared = "hello world shared between projects";
    await indexFile(db, { fileVersionId: "fvA", projectId: "projA", uri: "file:///a/shared.ts", text: shared });
    await indexFile(db, { fileVersionId: "fvB", projectId: "projB", uri: "file:///b/shared.ts", text: shared });

    // projB additionally holds 60 files that do not mention the query term, so an
    // out-of-scope project's hit must not displace them.
    for (let i = 0; i < 60; i++) {
      await indexFile(db, {
        fileVersionId: `fvB${i}`,
        projectId: "projB",
        uri: `file:///b/f${i}.ts`,
        text: `zeta quokka widget module number ${i}`,
      });
    }

    // projC has the same path on three branches, plus a $default version.
    for (const [fv, text] of [
      ["fvD", "greeting says default"],
      ["fvM", "greeting says mainline"],
      ["fvF", "greeting says feature"],
    ] as const) {
      await indexFile(db, {
        fileVersionId: fv,
        projectId: "projC",
        uri: "file:///c/greet.ts",
        text,
      });
    }
    await point(db, DEFAULT_BRANCH, "projC", "file:///c/greet.ts", "fvD");
    await point(db, "main", "projC", "file:///c/greet.ts", "fvM");
    await point(db, "feature", "projC", "file:///c/greet.ts", "fvF");
  });

  after(async () => {
    await db?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  void it("returns no hits from another project when scoped", async () => {
    const result = await search(db, "hello world", { projectId: "projA" });

    assert.ok(result.hits.length >= 1, "the in-scope shared file is found");
    for (const hit of result.hits) {
      assert.equal(hit.projectId, "projA", "every hit reports the requested project");
    }
    assert.equal(
      result.hits.some((h) => h.fileVersionId === "fvB"),
      false,
      "projB's file version of the shared chunk is not returned",
    );
  });

  void it("reports per-project match counts alongside the limited hits", async () => {
    // Counts cover the whole fused candidate pool, not BM25 matches only: the
    // vector arm always returns nearest neighbours, so a count of the returned
    // slice would understate what the scope covered.
    const scoped = await search(db, "hello world", { projectId: "projB", limit: 2 });
    assert.deepEqual(
      Object.keys(scoped.byProject),
      ["projB"],
      "no other project appears in the counts",
    );
    assert.ok(
      scoped.byProject.projB >= scoped.hits.length,
      "count is what matched, not what the limit returned",
    );
    assert.ok(scoped.hits.length >= 1);

    const wide = await search(db, "hello world", {});
    for (const project of ["projA", "projB"]) {
      assert.ok(
        project in wide.byProject,
        `unscoped must count each project's version of the shared pool row, got ${JSON.stringify(wide.byProject)}`,
      );
    }
    assert.equal(
      wide.hits.filter((h) => h.uri.endsWith("/a/shared.ts")).length,
      1,
      "one pool row is returned once per project version, never duplicated within a project",
    );
  });

  void it("returns a full limit of in-scope hits when the top of the index is out of scope", async () => {
    // 60 out-of-scope projA files rank above projB's content for this term, and the
    // candidate pool is deliberately far smaller than the corpus: a search that
    // fetched once and post-filtered would come back short of `limit`.
    for (let i = 0; i < 60; i++) {
      await indexFile(db, {
        fileVersionId: `fvA${i}`,
        projectId: "projA",
        uri: `file:///a/f${i}.ts`,
        text: `greeting widget ${i} says hello to the world loudly`,
      });
    }

    const result = await hybridSearch(
      db.table("chunks_pool"),
      db.table("vector_pool"),
      db.table("chunk_mapping"),
      db.table("file_mapping"),
      embedder,
      "hello world greeting",
      5,
      10, // candidate pool per source
      { projectId: "projB", candidateLimit: 10 },
    );

    assert.equal(result.hits.length, 5, `expected 5 in-scope hits, got ${result.hits.length}`);
    for (const hit of result.hits) assert.equal(hit.projectId, "projB");
    assert.ok(result.byProject.projB >= 5, "the count reflects what matched, not what was returned");
  });

  void it("scopes to one branch plus $default, never a sibling branch", async () => {
    const main = await search(db, "greeting says", {
      projectId: "projC",
      branch: "main",
      branchMapping: db.table("branch_mapping"),
    });
    const ids = main.hits.map((h) => h.fileVersionId).sort();
    assert.deepEqual(ids, ["fvD", "fvM"], "the main version and the branch-less version only");
    assert.equal(main.branch, "main", "the response echoes the scope it applied");

    const feature = await search(db, "greeting says", {
      projectId: "projC",
      branch: "feature",
      branchMapping: db.table("branch_mapping"),
    });
    assert.deepEqual(
      feature.hits.map((h) => h.fileVersionId).sort(),
      ["fvD", "fvF"],
      "switching branch switches the visible file version",
    );
  });

  void it("sees $default content when searching the sentinel branch", async () => {
    const result = await search(db, "greeting says", {
      projectId: "projC",
      branch: DEFAULT_BRANCH,
      branchMapping: db.table("branch_mapping"),
    });
    assert.deepEqual(result.hits.map((h) => h.fileVersionId), ["fvD"]);
  });

  void it("leaves a project with no pointers visible to any branch", async () => {
    // Indexed before branch tracking existed: its rows are all effectively
    // $default, and an upgrade must not empty the index.
    const result = await search(db, "hello world", {
      projectId: "projA",
      branch: "main",
      branchMapping: db.table("branch_mapping"),
    });
    assert.ok(result.hits.length >= 1);
    assert.equal(result.hits[0].projectId, "projA");
  });

  void it("spans every branch when no branch is given", async () => {
    const result = await search(db, "greeting says", { projectId: "projC" });
    assert.deepEqual(
      result.hits.map((h) => h.fileVersionId).sort(),
      ["fvD", "fvF", "fvM"],
      "search-all-style scoping is unfiltered by branch",
    );
    assert.equal(result.branch, null);
  });

  void it("refuses a branch with no project instead of widening", async () => {
    await assert.rejects(
      () => search(db, "greeting says", { branch: "main", branchMapping: db.table("branch_mapping") }),
      /branch scoping needs both projectId/,
    );
    await assert.rejects(
      () => search(db, "greeting says", { projectId: "projC", branch: "main" }),
      /branch scoping needs both projectId/,
    );
  });

  void it("stays unscoped across projects when no projectId is given", async () => {
    const result = await search(db, "hello world", {});
    assert.ok(
      new Set(result.hits.map((h) => h.projectId)).size >= 1,
      "an unscoped search may return either project",
    );
    assert.equal(result.branch, null);
  });
}

void describe("search scoping", scopingSuite);
