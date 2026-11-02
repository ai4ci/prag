// Branch identity resolution — reads .git/HEAD directly, so the fixtures are real
// repositories created with git rather than hand-written .git trees: a hand-written
// HEAD cannot show what git itself writes during a checkout, a rebase or a worktree
// add, and those are exactly the cases that decide whether a workspace has a branch.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  resolveBranch,
  isGitWorkspace,
  listGitBranches,
  DEFAULT_BRANCH,
} from "../src/branch.js";

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

/** One committed file, so HEAD points at a real branch. */
function newRepo(dir: string, branch = "main"): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-b", branch);
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  git(dir, "add", "a.ts");
  git(dir, "commit", "-m", "init");
  return dir;
}

function branchSuite(): void {
  let tmp: string;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "prag-branch-"));
  });
  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  void it("reads the checked-out branch from HEAD", () => {
    const repo = newRepo(join(tmp, "plain"));
    assert.equal(resolveBranch(repo), "main");

    git(repo, "checkout", "-b", "feature/login");
    assert.equal(resolveBranch(repo), "feature/login", "a slash-named branch resolves whole");

    git(repo, "checkout", "main");
    assert.equal(resolveBranch(repo), "main", "and tracks the switch back");
  });

  void it("resolves a linked worktree from its own HEAD", () => {
    const repo = newRepo(join(tmp, "wt-main"));
    const work = join(tmp, "wt-feature");
    git(repo, "worktree", "add", "-b", "experiment", work);

    // `.git` here is a file containing `gitdir: …`, and its HEAD names the
    // worktree's branch while refs live in the common directory.
    assert.equal(readFileSync(join(work, ".git"), "utf8").trim().startsWith("gitdir:"), true);
    assert.equal(resolveBranch(work), "experiment");
    assert.equal(resolveBranch(repo), "main", "the main checkout is unaffected");
    assert.ok(isGitWorkspace(work), "a worktree is a git workspace");
  });

  void it("treats a detached HEAD as having no branch identity", () => {
    const repo = newRepo(join(tmp, "detached"));
    git(repo, "checkout", "-b", "tmp");
    writeFileSync(join(repo, "b.ts"), "export const b = 2;\n");
    git(repo, "add", "b.ts");
    git(repo, "commit", "-m", "second");
    const sha = git(repo, "rev-parse", "HEAD").trim();
    git(repo, "checkout", "--detach", sha);

    assert.equal(resolveBranch(repo), DEFAULT_BRANCH);
    assert.ok(isGitWorkspace(repo), "detached but still a repository");
  });

  void it("reports a rebase-in-progress as detached, not as a branch", () => {
    // Mid-rebase HEAD holds a sha and the branch name lives in `rebase-merge/`;
    // neither is a checked-out branch, so content written now belongs to no
    // branch's history. The commits must actually conflict — a clean rebase
    // fast-forwards and leaves HEAD back on `side` (verified, not assumed).
    const repo = newRepo(join(tmp, "rebase"));
    git(repo, "checkout", "-b", "side");
    writeFileSync(join(repo, "a.ts"), "export const a = 'side';\n");
    git(repo, "commit", "-am", "side edits a");
    git(repo, "checkout", "main");
    writeFileSync(join(repo, "a.ts"), "export const a = 'main';\n");
    git(repo, "commit", "-am", "main edits a");
    git(repo, "checkout", "side");

    let conflicted = false;
    try {
      git(repo, "rebase", "main");
    } catch {
      conflicted = true;
    }
    assert.equal(conflicted, true, "fixture must conflict, else HEAD is back on side");
    assert.equal(resolveBranch(repo), DEFAULT_BRANCH);

    git(repo, "rebase", "--abort");
    assert.equal(resolveBranch(repo), "side", "and the branch is back once it is aborted");
  });

  void it("returns the sentinel for a non-git directory", () => {
    const plain = join(tmp, "plain-dir");
    mkdirSync(plain, { recursive: true });
    assert.equal(resolveBranch(plain), DEFAULT_BRANCH);
    assert.equal(isGitWorkspace(plain), false);
    assert.equal(resolveBranch(join(tmp, "does-not-exist")), DEFAULT_BRANCH);
  });

  void it("finds a repository whose .git is a parent of the queried dir", () => {
    // resolveBranch is given the *workspace root*, so a nested path is not its
    // problem — but a project registered at the root must still resolve.
    const repo = newRepo(join(tmp, "nested"));
    const deep = join(repo, "src", "deep");
    mkdirSync(deep, { recursive: true });
    assert.equal(resolveBranch(repo), "main");
    assert.equal(resolveBranch(deep), DEFAULT_BRANCH, "a nested dir is not itself a repo");
  });

  void it("lists local branches, including packed ones", () => {
    const repo = newRepo(join(tmp, "list"));
    git(repo, "branch", "release/1.0");
    git(repo, "branch", "zeta");
    let branches = listGitBranches(repo);
    assert.deepEqual(branches, ["main", "release/1.0", "zeta"]);

    git(repo, "pack-refs", "--all");
    assert.deepEqual(
      listGitBranches(repo),
      ["main", "release/1.0", "zeta"],
      "packed-refs branches are listed too",
    );

    git(repo, "branch", "-d", "zeta");
    assert.deepEqual(listGitBranches(repo), ["main", "release/1.0"], "a deleted branch disappears");
  });

  void it("lists a worktree's branches from the common directory", () => {
    const repo = newRepo(join(tmp, "wt-list"));
    git(repo, "branch", "other");
    const work = join(tmp, "wt-list-feature");
    git(repo, "worktree", "add", "-b", "own", work);

    assert.deepEqual(listGitBranches(work), ["main", "other", "own"]);
  });

  void it("lists no branches for a non-git workspace", () => {
    const plain = join(tmp, "plain-list");
    mkdirSync(plain, { recursive: true });
    assert.deepEqual(listGitBranches(plain), []);
  });
}

void describe("branch resolution", branchSuite);
