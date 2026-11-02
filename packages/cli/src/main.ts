#!/usr/bin/env node
// @prag/cli — Command line interface for prag

import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";
import { resolvePragPaths } from "@prag/core";
import { DaemonClient, DaemonError, ExitCode } from "./daemon-client.js";

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

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) usage();

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
        const tokenPath = join(paths.runDir, "daemon.token");
        writeFileSync(tokenPath, token, { mode: 0o600 });
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
    const query = rest.join(" ");
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
    }

    const result = await daemonClient.search({
      query,
      projectId,
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
    console.log(`\n${result.totalChunks} total chunks indexed`);
    return;
  }

  // ── Grant commands ──────────────────────────────────────
  if (cmd === "watch") {
    const uri = rest[0];
    if (!uri) { console.error("watch requires a URI"); usage(ExitCode.USAGE); }
    const normalizedUri = normalizeUri(uri);
    await daemonClient.addGrant(`${normalizedUri}/**`, "allow");

    // The grant alone indexes nothing: the daemon only watches registered
    // projects. projectId is the normalized root URI (cli-and-mcp-interface.md),
    // which is also what `search-local` resolves the cwd against.
    const projectId = getFlag(rest, "--project", "-p") ?? normalizedUri;
    await daemonClient.registerProject(projectId, normalizedUri);
    console.log(`Watching ${normalizedUri} (project ${projectId})`);
    console.log("Run `prag sync` to index it now, or let the watcher catch changes.");
    return;
  }

  if (cmd === "deny") {
    const uri = rest[0];
    if (!uri) { console.error("deny requires a URI"); usage(ExitCode.USAGE); }
    const normalizedUri = normalizeUri(uri);
    await daemonClient.addGrant(normalizedUri, "deny");
    console.log(`Denied ${normalizedUri}`);
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
    }
    return;
  }

  if (cmd === "status") {
    const h = await daemonClient.checkHealth();
    const uri = rest[0];
    if (uri) {
      console.log(`Status for ${normalizeUri(uri)}:`);
      console.log(`Daemon: running (PID ${h.pid})`);
      console.log(`Root:   ${h.root ?? "(none)"}`);
    } else {
      console.log(`Daemon running (PID ${h.pid}, API v${h.apiVersion})`);
      console.log(`Root: ${h.root ?? "(none)"}`);
      console.log(`Data: ${h.dataDir}`);
    }
    return;
  }

  if (cmd === "sync") {
    const result = await daemonClient.sync();
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
    console.log(`Re-embed requeued ${result.requeued} projects. Check status to track progress.`);
    return;
  }

  if (cmd === "pause") {
    const projectId = rest[0];
    if (!projectId) { console.error("pause requires a project ID"); usage(ExitCode.USAGE); }
    await daemonClient.pause(projectId);
    console.log(`Paused ${projectId}`);
    return;
  }

  if (cmd === "resume") {
    const projectId = rest[0];
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
      console.error(`Error [${err.code}]: ${err.message}`);
      if (err.remedy) console.error(`Remedy: ${err.remedy}`);
      process.exit(
        err.code === "NO_DAEMON" ? ExitCode.NO_DAEMON :
        err.code === "API_VERSION_MISMATCH" ? ExitCode.VERSION_MISMATCH :
        err.code === "PORT_CONFLICT" ? ExitCode.VERSION_MISMATCH :
        err.code === "AUTH_FAILED" ? ExitCode.AUTH_ERROR :
        ExitCode.FAILURE,
      );
    } else if (err instanceof Error) {
      console.error(`Unexpected error: ${err.message}`);
      process.exit(ExitCode.FAILURE);
    } else {
      console.error(String(err));
      process.exit(ExitCode.FAILURE);
    }
  });
}
