// @prag/core — Discovery dry run and grant policy primitives (ADR-009, ADR-023)
//
// Both `prag watch` and the MCP `watch_uri` tool must answer the same question
// before committing the machine to a scan: how much would this URI pull in, and
// is it allowed? Two implementations of that question drift, so there is one.

import { open, readdir, stat, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { evaluateUriGrants, type GrantRow } from "./schema.js";

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

/** Hidden files are ignored; `.gitignore` is the one exception (ADR-023). */
export function isBuiltinIgnored(filePath: string): boolean {
  const basename = filePath.split("/").pop() ?? "";
  if (BUILTIN_IGNORED_BASENAMES.has(basename)) return true;
  return basename.startsWith(".") && basename !== ".gitignore";
}

/** Why discovery excluded a file. `denied` means a grant refused it (ADR-009). */
export type SkipReason = "tooLarge" | "binary" | "empty" | "denied" | "unreadable";

export interface DiscoveryLimits {
  maxFileBytes?: number;
  ignored?: (path: string) => boolean;
  /** Override the confirmation threshold (defaults to DEFAULT_WATCH_CONFIRM_THRESHOLD). */
  threshold?: { projects: number; files: number };
}

export interface DryRunResult {
  files: number;
  /** Direct child git repositories — each becomes its own project (ADR-009). */
  projects: number;
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
  const ignored = limits.ignored ?? isBuiltinIgnored;
  const threshold = limits.threshold ?? DEFAULT_WATCH_CONFIRM_THRESHOLD;

  const result: DryRunResult = {
    files: 0,
    projects: 0,
    skipped: {},
    sample: [],
    exceedsThreshold: false,
    threshold,
  };
  const skip = (reason: SkipReason) => {
    result.skipped[reason] = (result.skipped[reason] ?? 0) + 1;
  };

  const rootPath = resolve(root);
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

      // A `.git/` directory marks an autonomous project boundary (ADR-009 §3).
      if (entry.isDirectory() && entry.name === ".git") {
        if (dir === rootPath) rootIsRepo = true;
        else result.projects++;
        continue;
      }

      if (ignored(full)) continue;

      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;

      const verdict = await probeFile(full, maxFileBytes);
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
): Promise<SkipReason | null> {
  let fd: FileHandle | undefined;
  try {
    const info = await stat(filePath);
    if (info.size > maxFileBytes) return "tooLarge";
    if (info.size === 0) return "empty";

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
