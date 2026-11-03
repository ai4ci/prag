#!/usr/bin/env node
// @prag/cli — Command line interface for prag

import { join } from "node:path";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { ensurePragDirs, resolveBranch, resolvePragPaths } from "@prag/core";
import { DaemonClient, DaemonError, ExitCode, exitForCode } from "./daemon-client.js";

function usage(exitCode = ExitCode.USAGE): never {
  const text = `Usage: prag <command> [args]

Commands:
  search-local <query>   Hybrid search scoped to the current project
  search-all  <query>    Hybrid search across all projects
  watch       <uri>      Add an allow grant and start indexing
  deny        <uri>      Add a deny grant and stop indexing
  grants                 List all active grant rules
  projects               List all registered projects
  status      [uri]      Show indexing status for a URI
  sync                   Drain debounced ingestion queues
  prune       [--gc-chunks]  Remove stale branch/pointer data
  reembed     [--model]  Rebuild index under a new embedding model
  pause       <project>  Pause scanning/ingestion for a project
  resume      <project>  Resume scanning/ingestion for a project
  daemon      <subcmd>   Manage the daemon process (start|stop|status|token|rotate-secret)

Options:
  --json       Output machine-readable JSON where applicable
  -p, --project <id>  Override project for search-local
  -b, --branch <name> Git branch context for search
  -n, --limit  <int>   Max results (default: 5)
  -m, --mode   <mode>  Search mode: hybrid|vector|fts (default: hybrid)
`;
  console.error(text);
  process.exit(exitCode);
}

/** "1,203 skipped (40 too large, 1,163 binary)" — or "" when nothing was skipped. */
export function summarizeSkipped(counters: Record<string, number> | undefined): string {
  if (!counters) return "";
  const entries = Object.entries(counters).filter(([, n]) => n > 0);
  if (entries.length === 0) return "";
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  const detail = entries
    .map(([reason, n]) => `${n.toLocaleString("en-US")} ${reason}`)
    .join(", ");
  return `${total.toLocaleString("en-US")} skipped (${detail})`;
}

function parseArgs(): Record<string, string[]> {
  const args = process.argv.slice(2);
  const positional: string[] = [];
  const flags: Record<string, string[]> = {};
  const named: string[] = [];
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        const key = a.slice(2, eq);
        (flags[key] ??= []).push(a.slice(eq + 1));
      } else if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
        (flags[a.slice(2)] ??= []).push(args[++i]);
      } else {
        (flags[a.slice(2)] ??= []).push("true");
      }
    } else if (a.startsWith("-") && a.length === 2) {
      const key = a[1];
      if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
        (flags[key] ??= []).push(args[++i]);
      } else {
        (flags[key] ??= []).push("true");
      }
    } else {
      named.push(a);
    }
    i++;
  }
  const result: Record<string, string[]> = { named };
  for (const [k, v] of Object.entries(flags)) {
    result[k] = v;
  }
  return result;
}

/** Version of the CLI package, read from its own package.json (single source). */
function cliVersion(): string {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version?: string };
  return pkg.version ?? "0.0.0";
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) usage();
  if (args[0] === "--version" || args[0] === "-v" || args[0] === "version") {
    console.log(cliVersion());
    return;
  }
  if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") usage(0);

  const cmd = args[0];
  const rest = args.slice(1);

  // Some commands need a client but skip apiVersion check
  const exemptCommands = new Set(["daemon"]);
  const daemonClient = new DaemonClient();

  switch (cmd) {
    // ── Daemon lifecycle (exempt from apiVersion check) ──
    case "daemon": {
      const sub = rest[0];
      if (!sub) usage();

      // Connect — no apiVersion check for these
      if (sub === "start") {
        // Check if already running
        const health = await daemonClient.health();
        if (health) {
          console.log(`Daemon already running (PID ${health.pid}, port ${health.port})`);
          return;
        }

        const h = await daemonClient.spawnDaemon();
        console.log(`Daemon started (PID ${h.pid}, port ${h.port})`);
        return;
      }

      // For stop/status/token/rotate-secret, connect to existing daemon
      const h = await daemonClient.checkHealth();

      if (sub === "stop") {
        if (h.service !== "prag-daemon") {
          console.error("No prag daemon running on the configured port");
          process.exit(ExitCode.NO_DAEMON);
        }
        await daemonClient.shutdown();
        console.log("Daemon stopped");
      } else if (sub === "status") {
        if (h.service !== "prag-daemon") {
          console.error("No prag daemon running");
          process.exit(ExitCode.NO_DAEMON);
        }
        console.log(`PID:     ${h.pid}`);
        console.log(`Port:    ${h.port}`);
        console.log(`Version: ${h.version} (API v${h.apiVersion})`);
        console.log(`Uptime:  ${h.uptime}s`);
        console.log(`Root:    ${h.root ?? "(none)"}`);
      } else if (sub === "token") {
        if (h.service !== "prag-daemon") {
          console.error("No prag daemon running");
          process.exit(ExitCode.NO_DAEMON);
        }
        console.log(daemonClient.token);
      } else if (sub === "rotate-secret") {
        // Regenerate the token file
        const token = crypto.randomUUID();
        const paths = resolvePragPaths();
        ensurePragDirs(paths);
        const tokenPath = join(paths.runDir, "daemon.token");
        writeFileSync(tokenPath, token, { mode: 0o600 });
        // `mode` is ignored when the file already exists, so set it explicitly --
        // same reason daemon/src/main.ts does this.
        chmodSync(tokenPath, 0o600);
        console.log(`New token written to ${tokenPath}`);
        console.log(`Set PRAG_API_KEY=${token} in the daemon's environment and restart.`);
      } else {
        usage();
      }
      return;
    }

    default: {
      // All other commands: check health + apiVersion
      const h = await daemonClient.health();
      if (!h) {
        // Try spawning
        const noSpawn = process.env.PRAG_NO_SPAWN === "1";
        if (noSpawn) {
          console.error("Daemon is not running and PRAG_NO_SPAWN is set. Start it with `prag daemon start`.");
          process.exit(ExitCode.NO_DAEMON);
        }
        console.error("Daemon not running — starting one...");
        const h2 = await daemonClient.spawnDaemon();
        daemonClient.checkApiVersion(h2, exemptCommands.has(cmd));
      } else {
        daemonClient.checkApiVersion(h, exemptCommands.has(cmd));
      }

      break;
    }
  }

  // ── Search commands ─────────────────────────────────────
  if (cmd === "search-local" || cmd === "search-all") {
    const query = positional(rest).join(" ");
    if (!query) {
      console.error("search-local requires a query string");
      usage(ExitCode.USAGE);
    }

    const isSearchAll = cmd === "search-all";
    const flagProject = getFlag(rest, "--project", "-p");
    const flagLimit = Number(getFlag(rest, "--limit", "-n") ?? "5");
    const flagMode = (getFlag(rest, "--mode", "-m") ?? "hybrid") as "hybrid" | "vector" | "fts";
    const useJson = rest.includes("--json");

    let projectId: string | undefined;
    if (isSearchAll) {
      // search-all: no project scoping
    } else {
      projectId = flagProject || (await daemonClient.inferProjectId()) || undefined;
      if (!projectId) {
        // ADR-018: "a search_local call without projectId is an error, never a
        // silent widening of scope." Sending undefined here used to search the
        // whole index from outside any project, which is the one thing the
        // command promises not to do.
        throw new DaemonError(
          "PROJECT_ID_REQUIRED",
          `No registered project contains ${process.cwd()}`,
          "Run prag watch <dir> first, pass --project <id>, use search-all to " +
            "search every project, or see registered ids with prag projects.",
        );
      }
    }

    // Branch context resolves on the client (cli-and-mcp-interface.md): the CLI has
    // the cwd, the daemon does not. Explicit --branch wins; otherwise read .git/HEAD
    // of the resolved project's root, falling back to the cwd. A non-git workspace
    // resolves to '$default', and a search with no project stays unscoped rather than
    // pretending a branch means something across repositories.
    const flagBranch = getFlag(rest, "--branch", "-b");
    let branch: string | undefined;
    if (projectId) {
      const root = await projectRootFor(projectId, daemonClient);
      branch = flagBranch ?? resolveBranch(root ?? process.cwd());
    } else if (flagBranch) {
      console.error("--branch needs a project to scope to; use search-local --project <id>");
      usage(ExitCode.USAGE);
    }

    const result = await daemonClient.search({
      query,
      projectId,
      branch,
      limit: isNaN(flagLimit) ? 5 : flagLimit,
      mode: flagMode,
    });

    if (useJson) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.hits.length === 0) {
      console.log("No results found.");
      return;
    }

    for (let i = 0; i < result.hits.length; i++) {
      const hit = result.hits[i]!;
      console.log(`[Hit ${i + 1}] (score: ${hit.score.toFixed(4)}) ${hit.projectId}`);
      console.log(`File: ${hit.uri}`);
      const best = hit.chunks[0];
      if (best?.scopeContext) console.log(`Scope: ${best.scopeContext}`);
      console.log("-".repeat(80));
    }
    // Not the index size: `totalChunks` is the fused RRF candidate pool for this
    // one query, so it moves with the query, the embedder and how many widening
    // rounds the search needed. Labelling it "indexed" made it look like a count
    // of the corpus, which changed between two searches of the same index.
    console.log(`\n${result.totalChunks} candidates considered`);
    return;
  }

  // ── Grant commands ──────────────────────────────────────
  if (cmd === "watch") {
    const uri = positional(rest)[0];
    if (!uri) { console.error("watch requires a URI"); usage(ExitCode.USAGE); }
    const normalizedUri = normalizeUri(uri);
    // projectId is the normalized root URI (cli-and-mcp-interface.md), which is
    // also what `search-local` resolves the cwd against.
    const projectId = getFlag(rest, "--project", "-p") ?? normalizedUri;
    const confirmed = getFlag(rest, "--yes", "-y") !== undefined;

    // One call: the daemon writes the allow grant, dry-runs discovery, and only
    // then registers the watcher. A grant alone indexes nothing (ADR-009 §5).
    try {
      const res = await daemonClient.watchUri(normalizedUri, projectId, confirmed);
      const d = res.discovered;
      const skipped = Object.values(d.skipped ?? {}).reduce((a, b) => a + b, 0);
      console.log(`Watching ${res.rootUri} (project ${res.projectId})`);
      console.log(`Discovered ${d.projects} project(s), ${d.files} file(s)` +
        (skipped ? `, ${skipped} skipped` : ""));
      console.log("Run `prag sync` to index it now, or let the watcher catch changes.");
    } catch (err) {
      const e = err as DaemonError;
      if (e.code === "WATCH_LIMIT_EXCEEDED") {
        const det = (e.details ?? {}) as { projects?: number; files?: number };
        console.error(`Would register ${det.projects} projects / ${det.files} files.`);
        console.error("Re-run with --yes to proceed (ADR-023). Nothing was changed.");
        process.exit(ExitCode.USAGE);
      }
      throw err;
    }
    return;
  }

  if (cmd === "deny") {
    const uri = positional(rest)[0];
    if (!uri) { console.error("deny requires a URI"); usage(ExitCode.USAGE); }
    const normalizedUri = normalizeUri(uri);
    const res = await daemonClient.addGrant(`${normalizedUri}/**`, "deny");
    console.log(`Denied ${normalizedUri}`);
    if (res && (res.purgedFiles || res.unwatched)) {
      if (res.purgedFiles) console.log(`Removed ${res.purgedFiles} indexed file(s) from search`);
      if (res.unwatched) console.log(`Un-watched project ${res.unwatched}`);
    }
    return;
  }

  if (cmd === "grants") {
    // grants evaluate <uri>
    if (args[0] === "evaluate") {
      if (!args[1]) {
        console.error("Usage: prag grants evaluate <uri>");
        process.exit(ExitCode.USAGE);
      }
      const uri = args[1].startsWith("file://") || args[1].startsWith("https://")
        ? args[1]
        : `file://${args[1]}`;
      const result = await daemonClient.evaluateGrant(uri);
      if (result.matched) {
        console.log(`${result.action} (matched "${result.pattern}")`);
      } else {
        console.log("deny (no matching grant rule)");
      }
      return;
    }

    const grants = await daemonClient.listGrants();
    if (grants.length === 0) {
      console.log("No grant rules configured.");
      return;
    }
    for (const g of grants) {
      console.log(`${g.action.padEnd(6)} ${g.pattern}${g.reason ? `  (${g.reason})` : ""}`);
    }
    return;
  }

  // ── Project commands ────────────────────────────────────
  if (cmd === "projects") {
    const projects = await daemonClient.listProjects();
    if (projects.length === 0) {
      console.log("No projects registered.");
      return;
    }
    for (const p of projects) {
      console.log(`${p.projectId.padEnd(30)} ${p.status.padEnd(10)} ${p.rootUri}`);
      const skipped = summarizeSkipped(p.skipped);
      if (skipped) console.log(`${" ".repeat(30)} ${skipped}`);
    }
    return;
  }

  if (cmd === "status") {
    const h = await daemonClient.checkHealth();
    // positional(), not rest[0]: `prag status --json` read "--json" as the URI and
    // printed a status line for a URI nobody typed.
    const uri = positional(rest)[0];
    if (uri) {
      console.log(`Status for ${normalizeUri(uri)}:`);
      console.log(`Daemon: running (PID ${h.pid})`);
      console.log(`Root:   ${h.root ?? "(none)"}`);
    } else {
      console.log(`Daemon running (PID ${h.pid}, API v${h.apiVersion})`);
      console.log(`Root: ${h.root ?? "(none)"}`);
      console.log(`Data: ${h.dataDir}`);
      if (h.embeddingModel) {
        // The device is named so a user can tell acceleration was picked up.
        const device = h.embeddingDevice ? `, ${h.embeddingDevice}` : "";
        console.log(`Embedding: ${h.embeddingModel} (${h.embeddingDim}d${device})`);
      }
      // ADR-024 requires the egress path be inspectable. "none" is the
      // interesting case, not an omission: it is what says the install sends
      // nothing anywhere, so it is printed rather than left blank.
      console.log(h.webBackend
        ? `Web: ${h.webBackend.id} -> ${h.webBackend.endpoint} ` +
          `(${h.webBackend.capabilities.join(", ")})`
        : "Web: none (local content only)");
      if (h.ingestion) {
        const i = h.ingestion;
        console.log(`Ingestion: ${i.projects} watched, ${i.dirty} queued, ` +
          `${i.inFlight} in flight, ${i.cooling} cooling`);
        // ADR-023: skipped-by-design has to be visible, or a user cannot tell
        // "excluded on purpose" from "silently missing".
        for (const [projectId, counters] of Object.entries(i.perProject)) {
          const skipped = summarizeSkipped(counters);
          if (skipped) console.log(`  ${projectId}: ${skipped}`);
        }
      }
    }
    return;
  }

  if (cmd === "sync") {
    let result: Awaited<ReturnType<DaemonClient["sync"]>>;
    try {
      result = await daemonClient.sync(getFlag(rest, "--project", "-p"));
    } catch (err) {
      // ADR-019: the drain is bounded, so say what is still outstanding instead
      // of reporting a sync that did not happen. Exit 8 = timeout.
      if (err instanceof DaemonError && err.code === "SYNC_TIMEOUT") {
        const pending = err.details?.pendingFiles ?? "?";
        const uris = (err.details?.pendingUris as string[] | undefined) ?? [];
        console.error(`Error [SYNC_TIMEOUT]: ${err.message} (${pending} files still pending)`);
        for (const uri of uris) console.error(`  pending: ${uri}`);
        if (err.remedy) console.error(`Remedy: ${err.remedy}`);
        process.exit(ExitCode.TIMEOUT);
      }
      throw err;
    }
    console.log(`Sync complete (ok: ${result.ok})`);
    if (result.flushedFiles !== undefined) {
      console.log(`  flushed: ${result.flushedFiles} files`);
    }
    if (result.pendingFiles !== undefined) {
      console.log(`  pending: ${result.pendingFiles} files`);
    }
    return;
  }

  // ── Maintenance commands ────────────────────────────────
  if (cmd === "prune") {
    const gcChunks = rest.includes("--gc-chunks");
    const result = await daemonClient.prune(gcChunks);
    console.log(
      `Pruned ${result.prunedFiles} files, ${result.prunedBranches} branches` +
        (result.gcChunks ? `, reclaimed ${result.purgedChunks} chunks` : ""),
    );
    return;
  }

  if (cmd === "reembed") {
    const model = getFlag(rest, "--model", "-m");
    const result = await daemonClient.reembed(model);
    // The model is echoed because the index has just been dropped and pinned to
    // it: a silent disagreement between --model and what was pinned is the bug
    // this command used to have.
    console.log(
      `Re-embed rebuilt the index under ${result.model} (dim ${result.dim}).\n` +
        `Requeued ${result.requeued} project(s) for a full rescan; ` +
        `run \`prag status\` to track progress.`,
    );
    return;
  }

  if (cmd === "pause") {
    const projectId = positional(rest)[0];
    if (!projectId) { console.error("pause requires a project ID"); usage(ExitCode.USAGE); }
    await daemonClient.pause(projectId);
    console.log(`Paused ${projectId}`);
    return;
  }

  if (cmd === "resume") {
    const projectId = positional(rest)[0];
    if (!projectId) { console.error("resume requires a project ID"); usage(ExitCode.USAGE); }
    await daemonClient.resume(projectId);
    console.log(`Resumed ${projectId}`);
    return;
  }

  usage();
}

/** Normalize a URI: expand ~, resolve relative paths to absolute file:// URIs */
function normalizeUri(input: string): string {
  if (input.startsWith("http://") || input.startsWith("https://")) return input;
  if (input.startsWith("file://")) return input;

  // Expand ~
  let path = input;
  if (path.startsWith("~")) {
    path = join(process.env.HOME || "/home/vp22681", path.slice(1));
  }

  // Resolve relative to cwd
  if (!path.startsWith("/")) {
    path = join(process.cwd(), path);
  }

  // Normalize and return as file:// URI
  const normalized = join(path);
  return `file://${normalized}`;
}

/** Extract a flag value from rest args. Looks for --long and -short forms. */
/** Value-bearing flags, so their tokens can be dropped from the query string. */
const VALUE_FLAGS = new Set([
  "--project", "-p", "--limit", "-n", "--mode", "-m", "--uri", "-u", "--branch", "-b",
]);

/**
 * Filesystem root of a registered project, for reading its `.git/HEAD`.
 * POST /projects stores `rootUri` as the caller sent it (daemon.ts:886), so it may
 * be a bare path rather than a file URL; `inferProjectId` already decodes it this
 * way and a search must not break on the difference. Null when the projectId is
 * unknown to the daemon.
 */
async function projectRootFor(
  projectId: string,
  client: DaemonClient,
): Promise<string | null> {
  const match = (await client.listProjects()).find((p) => p.projectId === projectId);
  if (!match) return null;
  return match.rootUri.startsWith("file://")
    ? fileURLToPath(match.rootUri)
    : match.rootUri;
}

/**
 * The query words, with flags removed. `rest.join(" ")` silently made the flags
 * part of the search text, so `prag search-local greet -p x --json` searched for
 * "greet -p x --json" — different results, and no way to say what you meant.
 *
 * shortcut: a query word beginning with "-" is read as a flag; quote-free
 * negative-number queries are not supported.
 */
function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--") || (a.startsWith("-") && a.length > 1)) {
      if (VALUE_FLAGS.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function getFlag(rest: string[], long: string, short?: string): string | undefined {
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === long || (short && a === short)) {
      // Next token
      if (i + 1 < rest.length && !rest[i + 1].startsWith("-")) {
        return rest[i + 1];
      }
      return "true";
    }
    // --key=value form
    if (a.startsWith(long + "=")) return a.slice(long.length + 1);
  }
  return undefined;
}

// ── Entry ──────────────────────────────────────────────────────────────

/**
 * Entry used by both `node bin/prag.mjs` (installed `prag`) and the direct
 * `tsx src/main.ts` invocation. The previous guard compared import.meta.filename
 * to process.argv[1], which is the *wrapper's* path when launched through bin,
 * so the installed command parsed its args and exited silently.
 */
// Self-start when run directly (`tsx packages/cli/src/main.ts …`, which is what
// the tests and README's source-only path do). The bin wrapper calls run().
if (/packages\/cli\/src\/main\.ts$/.test(process.argv[1] ?? "")) {
  void run();
}

export function run(): Promise<void> {
  return main().catch((err) => {
    if (err instanceof DaemonError) {
      // ADR-022 §4: default output is `message` then `remedy`, nothing else;
      // --json emits the envelope verbatim so scripts get what the API returned.
      // The code is deliberately absent from prose — it is in the envelope.
      if (process.argv.includes("--json")) {
        console.log(
          JSON.stringify({
            error: {
              code: err.code,
              message: err.message,
              ...(err.remedy ? { remedy: err.remedy } : {}),
              ...(err.details ? { details: err.details } : {}),
            },
          }),
        );
      } else {
        console.error(err.message);
        if (err.remedy) console.error(err.remedy);
      }
      process.exit(exitForCode(err.code));
    } else if (err instanceof Error) {
      console.error(`Unexpected error: ${err.message}`);
      process.exit(ExitCode.FAILURE);
    } else {
      console.error(String(err));
      process.exit(ExitCode.FAILURE);
    }
  });
}
