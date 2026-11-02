// @prag/core — ADR-009 §3: a git repository under a watched root is its own project.
//
// `discoveryDryRun` used to count child repositories into `projects` and throw
// the paths away, so a caller could learn that four repositories existed but
// not where they were — and registered one row for the whole tree.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoveryDryRun } from "../src/discovery.js";

function discoveryReposSuite(): void {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  function tree(): string {
    const root = mkdtempSync(join(tmpdir(), "prag-repos-"));
    roots.push(root);
    return root;
  }

  /** A directory that looks like a repository, with one indexable file. */
  function repo(dir: string, opts: { worktree?: boolean } = {}): string {
    mkdirSync(dir, { recursive: true });
    if (opts.worktree) {
      // A linked worktree's `.git` is a FILE holding a gitdir pointer.
      writeFileSync(join(dir, ".git"), "gitdir: /elsewhere/.git/worktrees/wt\n");
    } else {
      mkdirSync(join(dir, ".git"), { recursive: true });
      writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    }
    writeFileSync(join(dir, "code.ts"), "export const x = 1;\n");
    return dir;
  }

  void it("reports the path of every child repository, root first", async () => {
    const root = tree();
    repo(root);
    const beta = repo(join(root, "packages", "beta"));
    const alpha = repo(join(root, "packages", "alpha"));

    const res = await discoveryDryRun(root);

    assert.equal(res.projects, 3, "root plus two child repositories");
    // Root first is contract, not cosmetics: the caller registers it as the
    // parent and excludes the rest from its watcher.
    assert.equal(res.repos[0], root);
    assert.deepEqual(res.repos.slice(1).sort(), [alpha, beta].sort());
  });

  void it("counts a linked worktree, whose .git is a file not a directory", async () => {
    const root = tree();
    repo(root);
    const wt = repo(join(root, "wt"), { worktree: true });

    const res = await discoveryDryRun(root);

    // Requiring isDirectory() here silently folded every worktree into its
    // parent project.
    assert.ok(res.repos.includes(wt), `worktree missing from ${JSON.stringify(res.repos)}`);
    assert.equal(res.projects, 2);
  });

  void it("leaves repos empty for a plain directory with no repository", async () => {
    const root = tree();
    writeFileSync(join(root, "notes.md"), "# notes\n");

    const res = await discoveryDryRun(root);

    assert.deepEqual(res.repos, []);
    // The root is still a project; it is just not a repository.
    assert.equal(res.projects, 1);
  });

  void it("does not descend into a denied subtree to find repositories", async () => {
    const root = tree();
    repo(root);
    const hidden = repo(join(root, "vendor"));

    const res = await discoveryDryRun(root, [
      { pattern: `file://${root}/vendor/**`, action: "deny", reason: "user_deny", createdAt: new Date() },
    ]);

    assert.ok(!res.repos.includes(hidden), "a denied subtree was scanned for repositories");
  });
}

void describe("discoveryDryRun — child repositories", discoveryReposSuite);
