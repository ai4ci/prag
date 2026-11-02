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
const CLI_ENTRY = join(ROOT, "packages", "cli", "src", "main.ts");
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
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["--import", "tsx", CLI_ENTRY, ...args], {
      env: { ...process.env, ...env },
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
    const { stdout } = await runPrag(
      ["search-local", "greet", "-p", "someone-else", "--json"],
      ctx.env,
    );
    const result = JSON.parse(stdout) as { hits: unknown[] };
    assert.deepEqual(result.hits, [], "a project with no files returned results");
  });

  void it("search-all is the explicit unscoped path", async () => {
    const { stdout, code } = await runPrag(["search-all", "greet", "--json"], ctx.env);
    assert.equal(code, 0, stdout);
    const result = JSON.parse(stdout) as { hits: Array<{ uri: string }>[] };
    assert.ok(result.hits.length > 0, "search-all found nothing");
  });

  void it("exits with the usage code when a search command has no query", async () => {
    const { code } = await runPrag(["search-local"], ctx.env);
    assert.equal(code, 2, "usage errors must not exit 0");
  });
}

void describe("CLI subprocess end-to-end", subprocessEndToEndSuite);
