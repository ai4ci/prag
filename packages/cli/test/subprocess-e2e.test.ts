// @prag/cli — end-to-end through real processes.
//
// Every other test in this repo drives the daemon in-process, which is why the
// suite stayed green while `prag search` was broken for everyone: nothing ever
// started the daemon binary or sent it a real CLI request (issue:daemon-entry-
// point-has-no-main). This file starts the daemon with the same argv the CLI
// would use, then runs the CLI as a child process against it.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dirname!, "..", "..", "..");
const DAEMON_ENTRY = join(ROOT, "packages", "daemon", "src", "main.ts");
// The installed entry point: node_modules/.bin/prag links to this file, so
// running it here is the same route an installed `prag` takes.
const CLI_ENTRY = join(ROOT, "packages", "cli", "bin", "prag.mjs");
const TOKEN = "subprocess-token";

async function waitForDaemon(port: number, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) {
        const body = (await res.json()) as { service?: string };
        if (body.service === "prag-daemon") return;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`daemon did not become healthy on port ${port}`);
}

async function runPrag(
  args: string[],
  env: Record<string, string>,
  cwd?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [CLI_ENTRY, ...args], {
      env: { ...process.env, ...env },
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += String(d)));
    proc.stderr.on("data", (d) => (stderr += String(d)));
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });
}

function subprocessEndToEndSuite(): void {
  const ctx: {
    root: string;
    projectDir: string;
    port: number;
    daemon: ChildProcess | null;
    env: Record<string, string>;
  } = {
    root: "",
    projectDir: "",
    port: 7811,
    daemon: null,
    env: {},
  };

  before(async () => {
    ctx.root = mkdtempSync(join(tmpdir(), "prag-subproc-"));
    ctx.projectDir = join(ctx.root, "proj");
    mkdirSync(ctx.projectDir, { recursive: true });
    writeFileSync(
      join(ctx.projectDir, "greet.ts"),
      "export function greet(name: string) {\n  return `hi ${name}`;\n}\n",
    );

    ctx.env = {
      PRAG_ROOT: ctx.root,
      PRAG_PORT: String(ctx.port),
      PRAG_API_KEY: TOKEN,
      PRAG_EMBEDDING_MODEL: "fake:8",
      PRAG_WORKER_POOL_SIZE: "1",
      PRAG_NO_SPAWN: "1",
    };

    // PRAG_NO_SPAWN keeps the CLI from starting its own daemon, so this test
    // fails loudly if *this* daemon is not the one being reached.
    ctx.daemon = spawn(
      process.execPath,
      ["--import", "tsx", DAEMON_ENTRY],
      { env: { ...process.env, ...ctx.env }, stdio: "ignore", detached: true },
    );
    await waitForDaemon(ctx.port);
  });

  after(async () => {
    if (ctx.daemon?.pid) {
      try {
        process.kill(-ctx.daemon.pid, "SIGKILL");
      } catch {
        try {
          ctx.daemon.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
    if (ctx.root) rmSync(ctx.root, { recursive: true, force: true });
  });

  void it("the CLI reaches a daemon it did not spawn", async () => {
    const { stdout, stderr, code } = await runPrag(["daemon", "status"], ctx.env);
    assert.equal(code, 0, `status failed: ${stdout}${stderr}`);
    assert.match(stdout, /PID:/);
    assert.match(stdout, new RegExp(`Port:\\s+${ctx.port}`));
  });

  void it("registers, syncs and finds an indexed file by query", async () => {
    const headers = {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    };
    const reg = await fetch(`http://127.0.0.1:${ctx.port}/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ projectId: "sub-proj", rootUri: ctx.projectDir }),
    });
    assert.equal(reg.status, 200, await reg.text());

    const sync = await runPrag(["sync"], ctx.env);
    assert.equal(sync.code, 0, `sync failed: ${sync.stdout}${sync.stderr}`);
    assert.match(sync.stdout, /flushed: 1 files/);

    const search = await runPrag(
      ["search-local", "greet", "-p", "sub-proj", "--json"],
      ctx.env,
    );
    assert.equal(search.code, 0, `search failed: ${search.stdout}${search.stderr}`);

    const result = JSON.parse(search.stdout) as {
      hits: Array<{ uri: string; projectId: string; chunks: unknown[] }>;
    };
    assert.ok(result.hits.length > 0, "no hits for a file that was just indexed");
    assert.ok(
      result.hits.every((h) => h.projectId === "sub-proj"),
      "scoped search returned another project's file",
    );
    assert.ok(
      result.hits.some((h) => h.uri.endsWith("greet.ts")),
      `greet.ts missing: ${result.hits.map((h) => h.uri).join(", ")}`,
    );
  });

  void it("scoping hides another project's identical content", async () => {
    // A registered project that indexes nothing: the identical content in
    // sub-proj must not leak across the boundary (ADR-018).
    const emptyDir = join(ctx.root, "empty-proj");
    mkdirSync(emptyDir, { recursive: true });
    const reg = await fetch(`http://127.0.0.1:${ctx.port}/projects`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "empty-proj", rootUri: emptyDir }),
    });
    assert.equal(reg.status, 200, await reg.text());

    const scoped = await runPrag(["search-local", "greet", "-p", "empty-proj", "--json"], ctx.env);
    assert.equal(scoped.code, 0, scoped.stderr);
    const result = JSON.parse(scoped.stdout) as { hits: unknown[] };
    assert.deepEqual(result.hits, [], "a project with no files returned results");

    // ADR-022 §3: a search that matches nothing is a valid answer, not a failure.
    // fts mode, because the vector side always returns a nearest neighbour.
    const miss = await runPrag(
      ["search-local", "zzzplutoniumqqq", "-p", "sub-proj", "--mode", "fts", "--json"],
      ctx.env,
    );
    assert.equal(miss.code, 0, `a zero-result search must exit 0: ${miss.stderr}`);
    assert.deepEqual((JSON.parse(miss.stdout) as { hits: unknown[] }).hits, []);
  });

  void it("naming an unregistered project is an error, not an empty result (ADR-018)", async () => {
    // Empty and "you named nothing we know" must be distinguishable by code.
    const { stdout, stderr, code } = await runPrag(
      ["search-local", "greet", "-p", "someone-else", "--json"],
      ctx.env,
    );
    assert.equal(code, 7, `expected NOT_GRANTED, got ${code}: ${stdout}${stderr}`);
    // ADR-022 §4: --json emits the envelope verbatim, so `code` is assertable
    // without matching on prose.
    const env = JSON.parse(stdout) as { error: { code: string; message: string } };
    assert.equal(env.error.code, "PROJECT_NOT_FOUND");
  });

  void it("search-all is the explicit unscoped path", async () => {
    const { stdout, code } = await runPrag(["search-all", "greet", "--json"], ctx.env);
    assert.equal(code, 0, stdout);
    const result = JSON.parse(stdout) as { hits: Array<{ uri: string }>[] };
    assert.ok(result.hits.length > 0, "search-all found nothing");
  });

  void it("search-local outside every project is an error, not a whole-index search", async () => {
    // ADR-018: "a search_local call without projectId is an error, never a silent
    // widening of scope." The cwd here is outside both registered projects, so
    // inference finds nothing -- and this used to return sub-proj's files anyway,
    // which is precisely the widening the ADR forbids.
    const outside = join(ctx.root, "elsewhere");
    mkdirSync(outside, { recursive: true });
    const { stdout, code } = await runPrag(["search-local", "greet", "--json"], ctx.env, outside);
    assert.equal(code, 2, `expected the usage exit for PROJECT_ID_REQUIRED: ${stdout}`);
    const env = JSON.parse(stdout) as { error: { code: string; remedy?: string } };
    assert.equal(env.error.code, "PROJECT_ID_REQUIRED");
    assert.match(env.error.remedy ?? "", /search-all/, "remedy must name the way out");

    // The same query from inside the project still resolves by cwd.
    const inside = await runPrag(["search-local", "greet", "--json"], ctx.env, ctx.projectDir);
    assert.equal(inside.code, 0, `${inside.stdout}${inside.stderr}`);
    assert.ok(
      (JSON.parse(inside.stdout) as { hits: unknown[] }).hits.length > 0,
      "cwd inference stopped working",
    );
  });

  void it("--version reports the package version", async () => {
    const { stdout, code } = await runPrag(["--version"], ctx.env);
    assert.equal(code, 0, stdout);
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/, `unexpected: ${stdout}`);
  });

  void it("exits with the usage code when a search command has no query", async () => {
    const { code } = await runPrag(["search-local"], ctx.env);
    assert.equal(code, 2, "usage errors must not exit 0");
  });
}

void describe("CLI subprocess end-to-end", subprocessEndToEndSuite);
