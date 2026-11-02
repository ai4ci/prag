// @prag/core — branch identity for a workspace
//
// ADR/feature `git-branch-awareness`: the branch name is resolved lazily by
// reading `.git/HEAD`, never by polling `git branch --show-current`. A branch
// switch rewrites HEAD, so reading it at the moment a pointer is written is both
// correct and free of caches. No subprocess: a detached HEAD, an in-progress
// rebase and a non-git folder all resolve to `$default`, which is the sentinel
// the schema already reserves for "this workspace has no branch identity".

import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve as resolvePath } from "node:path";

/** Sentinel branch for non-git workspaces, web content, and detached HEADs. */
export const DEFAULT_BRANCH = "$default";

/**
 * Directory holding `HEAD` for a workspace, or null when it is not a repository.
 * Handles a worktree's `.git` *file* (`gitdir: …`), whose HEAD names its own
 * branch while refs live in the common directory.
 */
function gitDir(dir: string): string | null {
  const dotGit = join(dir, ".git");
  let info;
  try {
    info = statSync(dotGit);
  } catch {
    return null;
  }

  if (info.isFile()) {
    const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
    if (!match) return null;
    const target = match[1].trim();
    return isAbsolute(target) ? target : resolvePath(dir, target);
  }
  return info.isDirectory() ? dotGit : null;
}

/**
 * The branch whose content is checked out in `dir`, or `$default` when the
 * workspace has no branch identity (not a repository, detached HEAD, rebase).
 */
export function resolveBranch(dir: string): string {
  const git = gitDir(dir);
  if (!git) return DEFAULT_BRANCH;
  let head: string;
  try {
    head = readFileSync(join(git, "HEAD"), "utf8");
  } catch {
    return DEFAULT_BRANCH;
  }
  // `ref: refs/heads/main` is the only form with a branch name; a bare sha is a
  // detached HEAD, which promises no continuity across switches.
  const match = /^ref:\s*refs\/heads\/(.+)$/m.exec(head);
  return match ? match[1].trim() : DEFAULT_BRANCH;
}

/** True when `dir` is inside a git working tree (any HEAD, detached included). */
export function isGitWorkspace(dir: string): boolean {
  return gitDir(dir) !== null;
}

/**
 * Every local branch of the repository at `dir`, from loose refs and packed-refs.
 * Used by `prag prune` to drop pointers for branches deleted in git — an explicit,
 * manual call, so reading refs directly is fine (it is not the query path).
 * Empty for a non-git workspace.
 */
export function listGitBranches(dir: string): string[] {
  const git = gitDir(dir);
  if (!git) return [];

  // A worktree keeps HEAD to itself and shares refs with the main checkout.
  let refsDir = join(git, "refs", "heads");
  let packedPath = join(git, "packed-refs");
  try {
    const common = readFileSync(join(git, "commondir"), "utf8").trim();
    if (common) {
      const base = isAbsolute(common) ? common : resolvePath(git, common);
      refsDir = join(base, "refs", "heads");
      packedPath = join(base, "packed-refs");
    }
  } catch {
    /* no commondir: an ordinary repository */
  }

  const branches = new Set<string>();

  const walk = (current: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(join(current, entry.name), `${prefix}${entry.name}/`);
      } else if (entry.isFile()) {
        branches.add(`${prefix}${entry.name}`);
      }
    }
  };
  walk(refsDir, "");

  try {
    for (const line of readFileSync(packedPath, "utf8").split("\n")) {
      const match = /^[0-9a-f]{40}\s+refs\/heads\/(.+)$/.exec(line.trim());
      if (match) branches.add(match[1]);
    }
  } catch {
    /* no packed-refs */
  }

  return [...branches].sort();
}
