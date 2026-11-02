// @prag/daemon — the four policy tools over the MCP transport
// (feature:mcp-server-endpoint)
//
// Asserted through a real JSON-RPC session rather than by calling the handlers,
// because what is under test is that an agent sees the same envelope the CLI
// does (ADR-022 §2) — which is a property of the transport path, not of the
// operation methods.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { LanceDbSchema, FakeEmbeddingProvider, type ErrorEnvelope } from "@prag/core";
import { Daemon } from "../src/daemon.js";

const TOKEN = "test-mcp";

async function openSession(port: number) {
  const ac = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    signal: ac.signal,
  });
  if (res.status !== 200) throw new Error(`SSE open failed: ${res.status}`);

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const endpoint = await (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("SSE stream closed before the endpoint event");
      buffer += decoder.decode(value, { stream: true });
      const match = buffer.match(/data: (\/mcp\?sessionId=[^\r\n]+)/);
      if (match) return match[1];
    }
  })();

  let nextId = 1;
  const pending = new Map<number, (msg: any) => void>();
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const data = frame.match(/^data: (.*)$/m)?.[1];
        if (!data) continue;
        let msg: any;
        try {
          msg = JSON.parse(data);
        } catch {
          continue;
        }
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        }
      }
    }
  })();

  return {
    async request(method: string, params: Record<string, unknown> = {}): Promise<any> {
      const id = nextId++;
      const replied = new Promise<any>((resolve) => pending.set(id, resolve));
      const post = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });
      if (post.status !== 200 && post.status !== 202) {
        throw new Error(`POST ${method} -> ${post.status}: ${await post.text()}`);
      }
      const msg = await Promise.race([
        replied,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`no reply to ${method} within 5s`)), 5000),
        ),
      ]);
      if (msg.error) throw new Error(`JSON-RPC error on ${method}: ${JSON.stringify(msg.error)}`);
      return msg.result;
    },
    async close() {
      ac.abort();
      await pump.catch(() => {});
    },
  };
}

/** The JSON text of a tool result, which is where both success and failure travel. */
function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  assert.ok(first, "tool returned no content");
  return first.text ?? "";
}

function mcpPolicyToolSuite(): void {
  const ctx: {
    tmp: string;
    repo: string;
    schema: LanceDbSchema | null;
    daemon: Daemon | null;
    port: number;
    session: Awaited<ReturnType<typeof openSession>> | null;
  } = { tmp: "", repo: "", schema: null, daemon: null, port: 0, session: null };

  before(async () => {
    ctx.tmp = mkdtempSync(join(tmpdir(), "prag-mcp-tools-"));
    ctx.repo = join(ctx.tmp, "repo");
    mkdirSync(join(ctx.repo, "src"), { recursive: true });
    writeFileSync(join(ctx.repo, "src", "greeting.ts"), "export const greeting = 'hello world';\n");
    writeFileSync(join(ctx.repo, "secret.txt"), "the api key is abc123\n");
    execFileSync("git", ["init", "-b", "main"], { cwd: ctx.repo });

    ctx.schema = new LanceDbSchema({
      dbPath: join(ctx.tmp, "index"),
      embeddingDim: 4,
      maxVectorUnitTokens: 512,
      modelMaxSeqLength: 512,
    });
    await ctx.schema.init();
    ctx.daemon = new Daemon({
      port: 0,
      token: TOKEN,
      noExit: true,
      // watch_uri has to hand the directory to a worker pool; a daemon with no
      // pool refuses, which is its own test.
      ingestion: {
        poolSize: 1,
        cooldownMs: 20,
        // High enough for the 2-file fixture, low enough for the 3-file one.
        watchConfirmThreshold: { projects: 999, files: 2 },
      },
    });
    await ctx.daemon.start(ctx.schema, new FakeEmbeddingProvider(4));
    ctx.port = ctx.daemon.boundPort!;
    ctx.session = await openSession(ctx.port);
  });

  after(async () => {
    await ctx.session?.close();
    await ctx.daemon?.stop();
    await ctx.schema?.close();
    rmSync(ctx.tmp, { recursive: true, force: true });
    await new Promise((r) => setImmediate(r));
  });

  void it("advertises the four policy tools", async () => {
    const { tools } = await ctx.session!.request("tools/list");
    const names: string[] = tools.map((t: { name: string }) => t.name).sort();
    for (const required of [
      "search_local",
      "search_all",
      "list_grants",
      "list_projects",
      "watch_uri",
      "deny_uri",
      "prune_index",
      "get_indexing_status",
    ]) {
      assert.ok(names.includes(required), `missing tool: ${required} (have ${names.join(", ")})`);
    }
  });

  void it("watch_uri grants, registers and reports what it found", async () => {
    const result = await ctx.session!.request("tools/call", {
      name: "watch_uri",
      arguments: { uri: pathToFileURL(ctx.repo).href },
    });
    assert.notEqual(result.isError, true, textOf(result));
    const body = JSON.parse(textOf(result));
    assert.equal(body.projectId, ctx.repo);
    assert.ok(body.discovered.files >= 2, JSON.stringify(body));

    // The grant it promised actually exists, and the watcher is running.
    const grants = await ctx.schema!.table("grants").query().toArray();
    assert.ok(
      grants.some((g: any) => g.action === "allow" && String(g.pattern).startsWith(pathToFileURL(ctx.repo).href)),
      JSON.stringify(grants),
    );
    // Watched, not merely written to the tables — that distinction is what
    // statusFor's `watched` reports.
    const status = (await ctx.daemon!.statusFor(pathToFileURL(ctx.repo).href)) as {
      watched: boolean;
    };
    assert.equal(status.watched, true, "watch_uri wrote rows but registered nothing to watch");
  });

  void it("get_indexing_status reports the branch and what is indexed", async () => {
    const { status } = await fetch(`http://127.0.0.1:${ctx.port}/sync`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: ctx.repo }),
    });
    assert.equal(status, 200);

    const result = await ctx.session!.request("tools/call", {
      name: "get_indexing_status",
      arguments: { uri: pathToFileURL(ctx.repo).href },
    });
    assert.notEqual(result.isError, true, textOf(result));
    const body = JSON.parse(textOf(result));
    assert.equal(body.branch, "main", "a fresh `git init -b main` must report main");
    assert.ok(body.indexed.files >= 2, JSON.stringify(body));
    assert.equal(body.watched, true);
  });

  void it("an unknown workspace fails with PROJECT_NOT_FOUND, not prose", async () => {
    const result = await ctx.session!.request("tools/call", {
      name: "get_indexing_status",
      arguments: { uri: "file:///nonexistent/nowhere" },
    });
    assert.equal(result.isError, true, textOf(result));
    const envelope = JSON.parse(textOf(result)) as ErrorEnvelope;
    assert.equal(envelope.error.code, "PROJECT_NOT_FOUND");
    assert.ok(envelope.error.remedy, "an agent needs the remedy to act on the failure");
  });

  void it("deny_uri removes the covered files from search", async () => {
    const before = await fetch(`http://127.0.0.1:${ctx.port}/search`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "api", projectId: ctx.repo, mode: "fts", limit: 20 }),
    });
    const beforeBody = (await before.json()) as { hits: Array<{ uri: string }> };
    assert.ok(
      beforeBody.hits.some((f) => f.uri.endsWith("secret.txt")),
      "precondition: secret.txt is searchable",
    );

    const result = await ctx.session!.request("tools/call", {
      name: "deny_uri",
      arguments: { uri: `${pathToFileURL(ctx.repo).href}/secret.txt` },
    });
    assert.notEqual(result.isError, true, textOf(result));
    const body = JSON.parse(textOf(result));
    assert.equal(body.action, "deny");
    assert.ok(body.purgedFiles >= 1, JSON.stringify(body));

    const after = await fetch(`http://127.0.0.1:${ctx.port}/search`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "api", projectId: ctx.repo, mode: "fts", limit: 20 }),
    });
    const afterBody = (await after.json()) as { hits: Array<{ uri: string }> };
    assert.ok(
      !afterBody.hits.some((f) => f.uri.endsWith("secret.txt")),
      "a deny must take the file out of search immediately, not at the next restart",
    );
  });

  void it("watch_uri refuses an over-threshold watch and reports the counts", async () => {
    // ADR-023: an agent has no terminal to confirm at, so the guard fails with
    // the dry-run counts in `details` for it to put to the user. The threshold is
    // set to 2 files for this daemon, and this fixture has three.
    const big = join(ctx.tmp, "big");
    mkdirSync(big, { recursive: true });
    for (const name of ["a.ts", "b.ts", "c.ts"]) {
      writeFileSync(join(big, name), `export const ${name.slice(0, -3)} = "content of ${name}";
`);
    }

    const result = await ctx.session!.request("tools/call", {
      name: "watch_uri",
      arguments: { uri: pathToFileURL(big).href },
    });
    assert.equal(result.isError, true, "an over-threshold watch must not succeed silently");
    const envelope = JSON.parse(textOf(result)) as ErrorEnvelope;
    assert.equal(envelope.error.code, "WATCH_LIMIT_EXCEEDED");
    const details = envelope.error.details as { projects: number; files: number };
    assert.equal(details.files, 3, JSON.stringify(details));
    assert.ok(envelope.error.remedy?.includes("--yes"), envelope.error.remedy);

    // A refusal leaves no half-applied policy behind: no grant, no watcher.
    const grants = await ctx.schema!.table("grants").query().toArray();
    assert.ok(
      !grants.some((g: any) => String(g.pattern).startsWith(pathToFileURL(big).href)),
      "a refused watch must not have written its allow grant",
    );
  });

  void it("watch_uri offers no way for an agent to waive the threshold itself", async () => {
    // ADR-023: the human escalates with `prag watch <uri> --yes`. If the tool took
    // a confirm flag the agent could waive the very guard it is meant to report,
    // so the property is absent from the schema rather than merely undocumented.
    const { tools } = await ctx.session!.request("tools/list");
    const watch = tools.find((t: { name: string }) => t.name === "watch_uri");
    assert.ok(watch, "watch_uri not advertised");
    assert.ok(
      !("confirm" in (watch.inputSchema?.properties ?? {})),
      `watch_uri must not accept confirm: ${JSON.stringify(watch.inputSchema?.properties)}`,
    );
  });

  void it("prune_index runs the pointer sweep without touching the pool", async () => {
    const before = await ctx.schema!.table("chunks_pool").countRows();
    const result = await ctx.session!.request("tools/call", {
      name: "prune_index",
      arguments: {},
    });
    assert.notEqual(result.isError, true, textOf(result));
    const body = JSON.parse(textOf(result));
    assert.equal(body.gcChunks, false);
    assert.equal(body.purgedChunks, 0, "a plain prune must not reclaim pool rows (ADR-017)");
    assert.equal(await ctx.schema!.table("chunks_pool").countRows(), before);
  });

  void it("search_local scopes to the checked-out branch when none is given", async () => {
    // The result echoes the scope it applied, so this pins the default rather
    // than trusting it: `null` would mean "spanned every branch", which is what
    // omitting the filter used to do.
    const result = await ctx.session!.request("tools/call", {
      name: "search_local",
      arguments: { query: "hello world", projectId: ctx.repo, mode: "fts" },
    });
    assert.notEqual(result.isError, true, textOf(result));
    const body = JSON.parse(textOf(result)) as { branch: string | null };
    assert.equal(body.branch, "main", textOf(result));

    const explicit = await ctx.session!.request("tools/call", {
      name: "search_local",
      arguments: { query: "hello world", projectId: ctx.repo, mode: "fts", branch: "main" },
    });
    assert.equal(
      JSON.parse(textOf(explicit)).branch,
      "main",
      "an explicit branch must behave the same as the default",
    );
  });

  void it("search_all spans branches and advertises no branch filter", async () => {
    const { tools } = await ctx.session!.request("tools/list");
    const all = tools.find((t: { name: string }) => t.name === "search_all");
    assert.ok(!("branch" in (all.inputSchema?.properties ?? {})), "search_all must not accept branch");

    const result = await ctx.session!.request("tools/call", {
      name: "search_all",
      arguments: { query: "hello world", mode: "fts" },
    });
    assert.notEqual(result.isError, true, textOf(result));
    assert.equal(JSON.parse(textOf(result)).branch, null, textOf(result));
  });

  void it("both search tools take the three modes", async () => {
    const { tools } = await ctx.session!.request("tools/list");
    for (const name of ["search_local", "search_all"]) {
      const tool = tools.find((t: { name: string }) => t.name === name);
      const mode = tool.inputSchema?.properties?.mode;
      assert.ok(mode, `${name} must declare mode`);
      assert.deepEqual(
        [...mode.enum].sort(),
        ["fts", "hybrid", "vector"],
        JSON.stringify(mode),
      );
      assert.equal(mode.default, "hybrid");
    }

    // fts is not decoration: a term search must find the literal text.
    const result = await ctx.session!.request("tools/call", {
      name: "search_local",
      arguments: { query: "greeting", projectId: ctx.repo, mode: "fts" },
    });
    assert.notEqual(result.isError, true, textOf(result));
    assert.ok(JSON.parse(textOf(result)).hits.length > 0, textOf(result));
  });

  void it("two live sessions both answer tool calls", async () => {
    // A shared McpServer would have answered the second GET /mcp with a 500, so
    // this is the regression test for the one-server-per-session change.
    const second = await openSession(ctx.port);
    try {
      const result = await second.request("tools/call", { name: "list_projects", arguments: {} });
      assert.notEqual(result.isError, true, textOf(result));
      const projects = JSON.parse(textOf(result)) as Array<{ projectId: string }>;
      assert.ok(projects.some((p) => p.projectId === ctx.repo), textOf(result));

      const first = await ctx.session!.request("tools/call", {
        name: "list_grants",
        arguments: {},
      });
      assert.notEqual(first.isError, true, textOf(first));
    } finally {
      await second.close();
    }
  });
}

void describe("MCP policy tools", mcpPolicyToolSuite);
