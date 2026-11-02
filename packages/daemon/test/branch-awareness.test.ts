// @prag/daemon — branch awareness end to end (feature:git-branch-awareness)
//
// Drives a real git repository through checkout / edit / delete / branch -d against
// a running daemon, because the behaviour under test is which fileVersionId a branch
// points at after those operations happen. A hand-written .git tree cannot show that.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { LanceDbSchema, FakeEmbeddingProvider, DEFAULT_BRANCH } from "@prag/core";
import { Daemon } from "../src/daemon.js";

const TOKEN = "test-branch";
const HEADERS = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${TOKEN}`,
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}

async function post(port: number, path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function rows(db: LanceDbSchema, table: string): Promise<any[]> {
  return (await db.table(table).query().limit(10000).toArray()) as any[];
}

function branchAwarenessSuite(): void {
  const ctx: {
    tmp: string;
    repo: string;
    schema: LanceDbSchema | null;
    daemon: Daemon | null;
    port: number;
  } = { tmp: "", repo: "", schema: null, daemon: null, port: 0 };

  /** Search one branch and report which file versions came back. */
  async function versions(branch?: string): Promise<string[]> {
    const { status, json } = await post(ctx.port, "/search", {
      query: "greeting",
      projectId: "repo",
      limit: 20,
      mode: "fts",
      ...(branch ? { branch } : {}),
    });
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(
      branch ? json.branch : null,
      branch ?? null,
      "the response must echo the branch it scoped to",
    );
    return json.hits.map((h: any) => String(h.uri).split("/").pop() + "@" + h.fileVersionId);
  }

  async function sync(): Promise<void> {
    // /sync is a drain barrier, but a branch switch touches every file at once and
    // events keep arriving during the drain, so retry until empty (as a caller would).
    for (let i = 0; i < 8; i++) {
      const { json } = await post(ctx.port, "/sync", { projectId: "repo" });
      if (json.ok && json.pendingFiles === 0) return;
    }
    assert.fail("queue never drained after a checkout");
  }

  /**
   * Wait for a state only the WATCHER can produce. `/sync` reconciles additions and
   * changes against disk but deliberately not deletions (prune owns those), so a
   * removed file disappears from the index when chokidar reports it — which is
   * asynchronous and not covered by the drain barrier.
   */
  async function waitUntil(
    label: string,
    probe: () => boolean | Promise<boolean>,
  ): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (await probe()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.fail(`timed out waiting for: ${label}`);
  }

  async function pointers(): Promise<Array<{ branch: string; uri: string; fv: string }>> {
    return (await rows(ctx.schema!, "branch_mapping")).map((r) => ({
      branch: String(r.branch),
      uri: String(r.uri).split("/").pop()!,
      fv: String(r.fileVersionId),
    }));
  }

  before(async () => {
    ctx.tmp = mkdtempSync(join(tmpdir(), "prag-branch-e2e-"));
    ctx.repo = join(ctx.tmp, "repo");
    mkdirSync(ctx.repo, { recursive: true });
    git(ctx.repo, "init", "-b", "main");
    writeFileSync(join(ctx.repo, "greet.ts"), "export const greeting = 'from main';\n");
    git(ctx.repo, "add", ".");
    git(ctx.repo, "commit", "-m", "init");

    ctx.schema = new LanceDbSchema({ dbPath: ctx.tmp, embeddingDim: 4 });
    await ctx.schema.init();
    ctx.daemon = new Daemon({
      port: 0,
      token: TOKEN,
      noExit: true,
      ingestion: { poolSize: 1, cooldownMs: 20 },
    });
    await ctx.daemon.start(ctx.schema, new FakeEmbeddingProvider(4));
    ctx.port = ctx.daemon.boundPort!;

    const reg = await post(ctx.port, "/projects", { projectId: "repo", rootUri: ctx.repo });
    assert.equal(reg.status, 200, JSON.stringify(reg.json));
    await sync();
  });

  after(async () => {
    await ctx.daemon?.stop();
    await ctx.schema?.close();
    if (ctx.tmp) rmSync(ctx.tmp, { recursive: true, force: true });
    await new Promise((r) => setImmediate(r));
  });

  void it("writes a branch pointer for content indexed on the checked-out branch", async () => {
    const pts = await pointers();
    assert.deepEqual(pts, [
      { branch: "main", uri: "greet.ts", fv: pts[0]?.fv ?? "" },
    ], `expected one main pointer, got ${JSON.stringify(pts)}`);
    assert.ok(pts[0].fv, "the pointer names a file version");
  });

  void it("points each branch at its own version after a checkout", async () => {
    const mainVersion = (await pointers())[0].fv;

    git(ctx.repo, "checkout", "-b", "feature");
    writeFileSync(join(ctx.repo, "greet.ts"), "export const greeting = 'from feature';\n");
    git(ctx.repo, "commit", "-am", "feature edits the greeting");
    await sync();

    const pts = await pointers();
    const byBranch = Object.fromEntries(pts.map((p) => [p.branch, p]));
    assert.deepEqual(
      Object.keys(byBranch).sort(),
      ["feature", "main"],
      `both branches keep a pointer: ${JSON.stringify(pts)}`,
    );
    assert.notEqual(
      byBranch.feature.fv,
      mainVersion,
      "the feature branch points at the new content, not main's",
    );
    assert.equal(byBranch.main.fv, mainVersion, "main still points at its own historical version");

    // And the search really reflects it: each branch sees only its own greeting.
    assert.deepEqual(await versions("main"), [`greet.ts@${mainVersion}`]);
    assert.deepEqual(await versions("feature"), [`greet.ts@${byBranch.feature.fv}`]);

    git(ctx.repo, "checkout", "main");
    await sync();
    assert.deepEqual(await versions("main"), [`greet.ts@${mainVersion}`], "and back again");
  });

  void it("shares one file version for identical content across branches", async () => {
    // The same bytes committed on two branches must occupy one content-addressed
    // version (ADR-017) — and a subsequent checkout must move pointers only, with
    // no new file_mapping rows and no re-embedding.
    const filesBefore = (await rows(ctx.schema!, "file_mapping")).length;

    writeFileSync(join(ctx.repo, "same.ts"), "export const same = 'identical on both';\n");
    git(ctx.repo, "add", "same.ts");
    git(ctx.repo, "commit", "-m", "shared file on main");
    await sync();

    git(ctx.repo, "checkout", "feature");
    writeFileSync(join(ctx.repo, "same.ts"), "export const same = 'identical on both';\n");
    git(ctx.repo, "add", "same.ts");
    git(ctx.repo, "commit", "-m", "same bytes on feature");
    await sync();

    const pts = (await pointers()).filter((p) => p.uri === "same.ts");
    assert.deepEqual(
      [...new Set(pts.map((p) => p.branch))].sort(),
      ["feature", "main"],
      `both branches should point at same.ts: ${JSON.stringify(pts)}`,
    );
    assert.equal(
      new Set(pts.map((p) => p.fv)).size,
      1,
      `identical content must share one file version: ${JSON.stringify(pts)}`,
    );

    // And switching back and forth costs nothing: the content is unchanged on both
    // sides, so no version is created.
    git(ctx.repo, "checkout", "main");
    await sync();
    git(ctx.repo, "checkout", "feature");
    await sync();
    assert.equal(
      (await rows(ctx.schema!, "file_mapping")).length,
      filesBefore + 1,
      "a checkout must not add file_mapping rows for unchanged content — only the one new file counts",
    );
    git(ctx.repo, "checkout", "main");
    await sync();
  });

  void it("keeps another branch's index when a file is deleted on this one", async () => {
    git(ctx.repo, "checkout", "feature");
    writeFileSync(join(ctx.repo, "tempo.ts"), "export const greeting = 'tempo on feature';\n");
    git(ctx.repo, "add", ".");
    git(ctx.repo, "commit", "-m", "tempo on feature");
    await sync();

    const featureFv = (await pointers()).find((p) => p.uri === "tempo.ts")!.fv;

    git(ctx.repo, "checkout", "main");
    await sync();
    assert.deepEqual(
      (await pointers()).filter((p) => p.uri === "tempo.ts"),
      [{ branch: "feature", uri: "tempo.ts", fv: featureFv }],
      "main has no pointer, feature keeps its own",
    );
    assert.deepEqual(await versions("main"), (await versions("main")).filter((v) => !v.startsWith("tempo.ts")));

    // The version itself survives — it is still referenced, so it is not retired.
    assert.ok(
      (await rows(ctx.schema!, "file_mapping")).some((r) => r.fileVersionId === featureFv),
      "a file deleted on one branch must not vanish from the other's index",
    );
    assert.ok((await versions("feature")).some((v) => v.startsWith("tempo.ts")));

    git(ctx.repo, "checkout", "feature");
    rmSync(join(ctx.repo, "tempo.ts"));
    git(ctx.repo, "commit", "-am", "drop tempo");

    await waitUntil(
      "the unlink drops that branch's pointer",
      async () => (await pointers()).filter((p) => p.uri === "tempo.ts").length === 0,
    );
    await waitUntil(
      "the version is retired once no branch points at it",
      async () =>
        !(await rows(ctx.schema!, "file_mapping")).some((r) => r.fileVersionId === featureFv),
    );
    assert.equal(
      (await rows(ctx.schema!, "file_mapping")).some((r) => r.fileVersionId === featureFv),
      false,
      "once no branch points at it, the version is retired",
    );
    git(ctx.repo, "checkout", "main");
    await sync();
  });

  void it("drops pointers when a branch is deleted in git, and prunes orphaned versions", async () => {
    git(ctx.repo, "checkout", "main"); // cannot delete the branch we are standing on
    const before = await pointers();
    const featurePointers = before.filter((p) => p.branch === "feature");
    assert.ok(featurePointers.length > 0, "fixture must have feature pointers to prune");

    git(ctx.repo, "branch", "-D", "feature");
    const { json } = await post(ctx.port, "/prune", {});
    assert.equal(json.prunedBranches, featurePointers.length, JSON.stringify(json));

    const left = await pointers();
    assert.deepEqual(
      [...new Set(left.map((p) => p.branch))],
      ["main"],
      `only main should remain: ${JSON.stringify(left)}`,
    );

    const fileVersions = new Set((await rows(ctx.schema!, "file_mapping")).map((r) => r.fileVersionId));
    for (const p of featurePointers) {
      // A version main also points at (identical content) legitimately survives.
      const stillPointed = left.some((l) => l.fv === p.fv);
      assert.equal(
        fileVersions.has(p.fv),
        stillPointed,
        `${p.uri}@${p.fv}: orphaned=${!stillPointed} but still in file_mapping=${fileVersions.has(p.fv)}`,
      );
    }
    assert.ok(json.prunedVersions >= 1, `expected at least one orphaned version: ${JSON.stringify(json)}`);
  });

  void it("leaves a project without branch pointers out of the prune sweep", async () => {
    // A non-git directory: everything it indexes is $default, and deleting its
    // files because a *different* project has pointers would be data loss.
    const plain = join(ctx.tmp, "plain");
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(plain, "note.ts"), "export const greeting = 'plain workspace';\n");
    const reg = await post(ctx.port, "/projects", { projectId: "plain", rootUri: plain });
    assert.equal(reg.status, 200);
    for (let i = 0; i < 8; i++) {
      const { json } = await post(ctx.port, "/sync", { projectId: "plain" });
      if (json.ok) break;
    }

    const { json } = await post(ctx.port, "/prune", {});
    assert.equal(json.prunedVersions, 0, JSON.stringify(json));

    const search = await post(ctx.port, "/search", {
      query: "greeting",
      projectId: "plain",
      mode: "fts",
    });
    assert.ok(
      search.json.hits.some((h: any) => String(h.uri).endsWith("note.ts")),
      `plain workspace lost its index: ${JSON.stringify(search.json.hits)}`,
    );
    assert.ok(
      (await rows(ctx.schema!, "branch_mapping")).some(
        (r) => r.projectId === "plain" && r.branch === DEFAULT_BRANCH,
      ),
      "a non-git workspace is indexed under the $default sentinel",
    );
  });

  void it("rejects a branch with no project instead of searching everything", async () => {
    const { status, json } = await post(ctx.port, "/search", {
      query: "greeting",
      branch: "main",
    });
    assert.equal(status, 400);
    assert.equal(json.error.code, "INVALID_REQUEST");
    assert.match(json.error.message, /requires 'projectId'/);
  });
}

void describe("daemon branch awareness", branchAwarenessSuite);
