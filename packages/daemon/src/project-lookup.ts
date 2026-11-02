// @prag/daemon — project lookup shared by the HTTP handler and the MCP tools
//
// Lives apart from daemon.ts because mcp-server.ts is imported *by* daemon.ts;
// importing back would close a cycle. Both surfaces must reject an unknown
// project the same way (ADR-018), so the check exists once.
import { DaemonFailure, type LanceDbSchema } from "@prag/core";

/** True when `projectId` is a registered row in `projects`. */
export async function projectExists(
  db: LanceDbSchema,
  projectId: string,
): Promise<boolean> {
  // Ids are ours (a digest of the root uri) but arrive from the wire, so quote
  // them rather than interpolating into the LanceDB filter.
  const literal = `'${projectId.replace(/'/g, "''")}'`;
  const rows = await db
    .table("projects")
    .query()
    .filter(`projectId = ${literal}`)
    .limit(1)
    .toArray();
  return rows.length > 0;
}

/**
 * ADR-018: an unknown project is a client error, never an empty result set —
 * "no matches" and "you named nothing we know" must be distinguishable.
 */
export async function assertProjectRegistered(
  db: LanceDbSchema,
  projectId: string,
): Promise<void> {
  if (await projectExists(db, projectId)) return;
  throw new DaemonFailure(
    "PROJECT_NOT_FOUND",
    `project '${projectId}' is not registered`,
    "List ids with `prag projects`, or register one with `prag watch <dir>`.",
    { projectId },
  );
}
