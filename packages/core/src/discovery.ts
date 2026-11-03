// @prag/core — Discovery dry run and grant policy primitives (ADR-009, ADR-023)
//
// Both `prag watch` and the MCP `watch_uri` tool must answer the same question
// before committing the machine to a scan: how much would this URI pull in, and
// is it allowed? Two implementations of that question drift, so there is one.

import { open, readdir, stat, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { evaluateUriGrants, type GrantRow } from "./schema.js";
import { documentCategory, DEFAULT_MAX_DOCUMENT_BYTES } from "./document-formats.js";

/** ADR-023 defaults. */
export const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_WATCH_CONFIRM_THRESHOLD = { projects: 25, files: 20_000 };
const BINARY_DETECTION_BYTES = 8192;

/** Built-in ignores (ADR-023). These sit alongside grants, not in place of them. */
export const BUILTIN_IGNORED_BASENAMES = new Set([
  "node_modules",
  "package-lock.json",
  ".git",
  ".hg",
  ".svn",
  "target",
  "dist",
  "build",
  ".next",
  ".venv",
  "__pycache__",
]);

/** Split a path on either separator, so a Windows path is tested too. */
function segmentsOf(filePath: string): string[] {
  return filePath.split(/[/\\]/);
}

function isIgnoredSegment(segment: string): boolean {
  if (!segment) return false;
  return BUILTIN_IGNORED_BASENAMES.has(segment) ||
    (segment.startsWith(".") && segment !== ".gitignore");
}

/**
 * Hidden files are ignored; `.gitignore` is the one exception (ADR-023).
 *
 * Every path segment is tested, not just the basename: chokidar reports
 * `/repo/.git/config` as a single event, and a basename-only test called that
 * indexable — the daemon was indexing git's internals, including COMMIT_EDITMSG
 * and loose refs, and they showed up in search results. Discovery already skips
 * such directories by name while walking, so this makes the watcher agree with
 * what a user confirmed before `watch`.
 *
 * **`root` matters.** Tested against the whole absolute path, this said "yes"
 * to every file in a project that merely *lives* under a hidden or
 * conventionally-ignored ancestor: `prag watch ~/.config/notes` reported `0
 * files` with an empty `skipped` map and indexed nothing, because `.config` is
 * a hidden segment. Same for anything under a directory called `build`,
 * `target` or `dist`. Only the segments *below* the project root describe the
 * project's own layout, so only those are tested. Omitting `root` keeps the old
 * whole-path behaviour, which is right for a caller that has no root.
 */
export function isBuiltinIgnored(filePath: string, root?: string): boolean {
  let tested = filePath;
  if (root) {
    const rel = relative(root, filePath);
    // `relative` returning something that climbs out means the path is not
    // under the root at all; fall back to testing all of it rather than
    // silently admitting it.
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) tested = rel;
  }
  return segmentsOf(tested).some(isIgnoredSegment);
}

/**
 * Errors that say "not right now", not "not ever".
 *
 * `EMFILE`/`ENFILE` are descriptor exhaustion, `ENOMEM` memory pressure,
 * `EAGAIN`/`EBUSY` transient contention. Under load every one of them arrives
 * at the same `catch` as `EACCES`, and treating them alike records a passing
 * resource shortage as a permanent property of the file: it is skipped as
 * "unreadable", the counter says so, and nothing retries it. The distinction
 * matters wherever a skip is final.
 */
export function isTransientFsError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "EMFILE" || code === "ENFILE" || code === "ENOMEM" ||
    code === "EAGAIN" || code === "EBUSY" || code === "EINTR";
}

/** Why discovery excluded a file. `denied` means a grant refused it (ADR-009). */
export type SkipReason =
  | "tooLarge" | "binary" | "empty" | "denied" | "unreadable"
  /**
   * Not examined this time because of a transient failure (see
   * `isTransientFsError`). Distinct from `unreadable`, which is final: a
   * deferred file is back on the queue and the next drain retries it. Shown
   * separately so a reader is not told a file was skipped when it was only
   * postponed.
   */
  | "deferred";

export interface DiscoveryLimits {
  maxFileBytes?: number;
  /** Byte cap for DOCUMENT_FORMATS; default 32MB. Separate from maxFileBytes. */
  maxDocumentBytes?: number;
  ignored?: (path: string) => boolean;
  /** Override the confirmation threshold (defaults to DEFAULT_WATCH_CONFIRM_THRESHOLD). */
  threshold?: { projects: number; files: number };
}

export interface DryRunResult {
  files: number;
  /** Direct child git repositories — each becomes its own project (ADR-009). */
  projects: number;
  /**
   * Absolute path of every git repository found, the root first when it is one
   * (ADR-009 §3). `projects` is the count a confirmation prompt shows; this is
   * what the caller registers, so a child repo becomes its own `projects` row
   * rather than being swallowed into its parent's.
   *
   * A plain directory with no repository under it yields an empty list: the
   * root is still a project, but it is not a repository and the caller already
   * knows its path.
   */
  repos: string[];
  skipped: Partial<Record<SkipReason, number>>;
  /** First 20 inclusions, so a confirmation prompt can show what is being accepted. */
  sample: string[];
  /** True when either count exceeds ingestion.watchConfirmThreshold. */
  exceedsThreshold: boolean;
  threshold: { projects: number; files: number };
}

/** `file:///a/b/**` → `/a/b`; a plain path is returned unchanged. */
export function grantPatternToPath(pattern: string): string {
  let p = pattern;
  if (p.startsWith("file://")) p = p.slice("file://".length);
  if (p.endsWith("/**")) p = p.slice(0, -3);
  return p;
}

export function pathToGrantPattern(filePath: string, action: "allow" | "deny" = "allow"): string {
  return `${pathToFileURL(resolve(filePath)).href}/**`;
}

/**
 * True when some *deny* grant covers this path.
 *
 * Allow is deliberately not required here: the caller is about to add the allow
 * for the root it was given, and children of a registered root are in scope by
 * containment (ADR-009 §1). Deny is what a user says to carve a hole back out,
 * so deny is the side that must be consulted before anything is watched.
 */
export function isDenied(filePath: string, grants: GrantRow[]): boolean {
  const uri = pathToFileURL(resolve(filePath)).href;
  const denies = grants.filter((g) => g.action === "deny");
  if (denies.length === 0) return false;
  return evaluateUriGrants(uri, denies).action === "deny";
}

/**
 * Walk a tree and report what indexing it would involve, without reading file
 * contents beyond the 8KB binary probe. Nothing is written and nothing is
 * enqueued — this is the dry run ADR-023 requires before `watch`.
 */
export async function discoveryDryRun(
  root: string,
  grants: GrantRow[] = [],
  limits: DiscoveryLimits = {},
): Promise<DryRunResult> {
  const maxFileBytes = limits.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxDocumentBytes = limits.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
  // Root-relative: a project under `~/.config` or inside a directory called
  // `build` is a project, not a thing to skip. Only the layout below the root
  // is the project's own.
  const rootPath = resolve(root);
  const ignored = limits.ignored ?? ((p: string) => isBuiltinIgnored(p, rootPath));
  const threshold = limits.threshold ?? DEFAULT_WATCH_CONFIRM_THRESHOLD;

  const result: DryRunResult = {
    files: 0,
    projects: 0,
    repos: [],
    skipped: {},
    sample: [],
    exceedsThreshold: false,
    threshold,
  };
  const skip = (reason: SkipReason) => {
    result.skipped[reason] = (result.skipped[reason] ?? 0) + 1;
  };

  let rootIsRepo = false;
  const stack = [rootPath];
  while (stack.length > 0) {
    const dir = stack.pop()!;

    // A denied subtree is not descended into at all: the watcher would never be
    // allowed to watch it, so counting its files would misreport the cost.
    if (dir !== rootPath && isDenied(dir, grants)) {
      skip("denied");
      continue;
    }

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      skip("unreadable");
      continue;
    }

    for (const entry of entries) {
      const full = join(dir, entry.name);

      // A `.git` entry marks an autonomous project boundary (ADR-009 §3). It is
      // tested without isDirectory(): in a linked worktree `.git` is a *file*
      // holding a gitdir pointer, and requiring a directory silently treated
      // every worktree as part of its parent.
      if (entry.name === ".git") {
        if (dir === rootPath) rootIsRepo = true;
        else result.projects++;
        result.repos.push(dir);
        continue;
      }

      if (ignored(full)) continue;

      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;

      const verdict = await probeFile(full, maxFileBytes, maxDocumentBytes);
      if (verdict === "denied") skip("denied");
      else if (verdict !== null) skip(verdict);
      else {
        result.files++;
        if (result.sample.length < 20) result.sample.push(full);
      }
    }
  }

  // The root is a project in its own right (repo or plain directory); child
  // repos found underneath are additional projects (ADR-009 §3).
  if (rootIsRepo || result.projects === 0) result.projects += 1;
  // Root first: the caller registers it as the parent and excludes the rest
  // from its watcher, so the order is part of the contract rather than cosmetic.
  result.repos.sort((a, b) => (a === rootPath ? -1 : b === rootPath ? 1 : a.localeCompare(b)));
  result.exceedsThreshold =
    result.projects > threshold.projects || result.files > threshold.files;
  return result;
}

/**
 * Read enough of a file to decide whether it is indexable, without reading it
 * whole. Shared by the discovery dry run and the ingestion admission gate so the
 * two cannot disagree about what a skip means (ADR-023).
 */
export async function probeFile(
  filePath: string,
  maxFileBytes: number,
  maxDocumentBytes: number = DEFAULT_MAX_DOCUMENT_BYTES,
): Promise<SkipReason | null> {
  // A document is binary by construction -- a PDF has NUL bytes in its first
  // 8KB -- so the NUL test would reject every one of them before a parser saw
  // it. "Binary" here means "not text and nothing can read it", and that is
  // no longer true of the formats in DOCUMENT_FORMATS. They also get their
  // own byte cap: `maxFileBytes` is 2MB, sized for source files, which would
  // refuse most real PDFs.
  const isDocument = documentCategory(filePath) !== null;
  let fd: FileHandle | undefined;
  try {
    const info = await stat(filePath);
    if (info.size > (isDocument ? maxDocumentBytes : maxFileBytes)) return "tooLarge";
    if (info.size === 0) return "empty";
    if (isDocument) return null;

    fd = await open(filePath, "r");
    const buf = Buffer.alloc(BINARY_DETECTION_BYTES);
    const { bytesRead } = await fd.read(buf, 0, BINARY_DETECTION_BYTES, 0);
    if (buf.subarray(0, bytesRead).includes(0)) return "binary";
    return null;
  } catch {
    return "unreadable";
  } finally {
    await fd?.close();
  }
}
