// @prag/core — 7-table LanceDB storage schema
//
// Two concepts are deliberately kept apart (ADR-014):
//   - A chunk is one complete structural unit (retrieval unit, content-addressed).
//   - A vectorised unit is a sliding token window over a chunk (embedding unit).

// ── Enums ────────────────────────────────────────────────────────────

export type GrantAction = "allow" | "deny";
export type GrantReason = "watch_root" | "explicit_grant" | "user_deny" | "builtin_ignore";
export type ProjectStatus = "idle" | "indexing" | "error" | "paused";

// ── Row interfaces (mapping direct to LanceDB table columns) ─────────

/** 1. grants — unified allow/deny URI policy rule set. */
export interface GrantRow {
  pattern: string;
  action: GrantAction;
  reason: GrantReason;
  createdAt: Date;
}

/** 2. projects — discovered project boundaries. */
export interface ProjectRow {
  projectId: string;
  rootUri: string;
  name: string;
  isGit: boolean;
  defaultCooldownSeconds: number | null;
  status: ProjectStatus;
  registeredAt: Date;
  lastSyncedAt: Date | null;
}

/** 3. branch_mapping — mutable working-state pointers to file versions. */
export interface BranchMappingRow {
  branch: string;
  projectId: string;
  uri: string;
  fileVersionId: string;
  updatedAt: Date;
}

/** 4. file_mapping — immutable content-addressed file versions. */
export interface FileMappingRow {
  fileVersionId: string;
  projectId: string;
  uri: string;
  validUntil: Date | null;
  contentHash: string;
  language: string;
}

/** 5. chunk_mapping — ordered chunk sequences within a file version. */
export interface ChunkMappingRow {
  fileVersionId: string;
  chunkIndex: number;
  chunkHash: string;
}

/** 6. chunks_pool — deduplicated global chunk content (BM25 target). */
export interface ChunksPoolRow {
  chunkHash: string;
  text: string;
  scopeContext: string | null;
}

/** 7. vector_pool — dense embeddings per vectorised unit. */
export interface VectorPoolRow {
  chunkHash: string;
  unitIndex: number;
  vector: Float32Array;
}

// ── Query helpers ────────────────────────────────────────────────────

export interface SearchQueryOptions {
  query: string;
  projectId?: string;
  branch?: string;
  limit?: number;
}

export interface SearchHit {
  chunkHash: string;
  text: string;
  scopeContext: string | null;
  projectId: string;
  uri: string;
  branch: string;
  score: number;
}

export interface GrantEvaluation {
  matched: boolean;
  action: GrantAction | null;
  pattern: string | null;
}

/**
 * Evaluate a URI against the grants table.
 * Semantics: deny-by-default, longest-prefix match wins, deny breaks ties.
 * shortcut: O(n) scan — fine for the expected grant count (<1000), upgrade to a trie if it becomes a hot path.
 */
export function evaluateUriGrants(
  uri: string,
  grants: GrantRow[],
): GrantEvaluation {
  let matched: GrantRow | null = null;

  for (const grant of grants) {
    if (uriMatch(uri, grant.pattern)) {
      if (
        matched === null ||
        grant.pattern.length > matched.pattern.length ||
        (grant.pattern.length === matched.pattern.length && grant.action === "deny")
      ) {
        matched = grant;
      }
    }
  }

  if (matched === null) {
    return { matched: false, action: null, pattern: null };
  }
  return { matched: true, action: matched.action, pattern: matched.pattern };
}

function uriMatch(uri: string, pattern: string): boolean {
  // Glob-style: "**" matches everything after, plain prefix otherwise
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return uri.startsWith(prefix);
  }
  return uri === pattern;
}
