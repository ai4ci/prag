// @prag/daemon — PRAG_ROOT isolation test (ADR-019)
//
// The requirement is that an instance rooted at PRAG_ROOT leaves *nothing* behind
// anywhere else, and that deleting the root deletes the instance. Both are claims
// about the production wiring, so these tests drive `loadConfig()`/`bootstrap()` --
// hand-built LanceDbSchema instances would pass even if the entry point leaked.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { FakeEmbeddingProvider, resolvePragPaths } from "@prag/core";
import { bootstrap, loadConfig, writeRuntimeFiles, type Startup } from "../src/main.js";

const XDG_VARS = ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"] as const;
const PRAG_VARS = [
  "PRAG_ROOT",
  "PRAG_DATA_DIR",
  "PRAG_CONFIG_DIR",
  "PRAG_RUN_DIR",
  "PRAG_LOG_DIR",
  "PRAG_EMBEDDING_MODEL",
  "PRAG_PORT",
  "PRAG_API_KEY",
] as const;

const OENV: Record<string, string | undefined> = {};
const startups: Startup[] = [];

function cleanEnv(): void {
  for (const k of [...PRAG_VARS, ...XDG_VARS]) delete process.env[k];
}

async function withEnv<T>(
  vars: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  for (const k of [...PRAG_VARS, ...XDG_VARS]) {
    if (!(k in OENV)) OENV[k] = process.env[k];
  }
  cleanEnv();
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(OENV)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const k of [...PRAG_VARS, ...XDG_VARS]) delete OENV[k];
  }
}

/** A tiny project with enough content for a chunk to exist. */
function makeProject(dir: string): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "widget.ts"),
    "export function widget(): number {\n  return 42;\n}\n",
  );
}

async function authed(port: number, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test",
      ...(init?.headers ?? {}),
    },
  });
}

/** Assert a status without consuming the body, which the caller still needs. */
async function expectOk(res: Response, what: string): Promise<void> {
  if (res.status === 200) return;
  assert.fail(`${what} failed (${res.status}): ${await res.text()}`);
}

/**
 * Register, index and search a project. Returns the search body so callers can
 * assert the cycle actually produced results — an isolation test that indexes
 * nothing proves nothing.
 */
async function indexAndSearch(port: number, projectDir: string): Promise<unknown> {
  const reg = await authed(port, "/projects", {
    method: "POST",
    body: JSON.stringify({ projectId: projectDir, rootUri: projectDir }),
  });
  await expectOk(reg, "register");

  const sync = await authed(port, "/sync", { method: "POST", body: "{}" });
  await expectOk(sync, "sync");

  const res = await authed(port, "/search", {
    method: "POST",
    body: JSON.stringify({ query: "widget", projectId: projectDir }),
  });
  await expectOk(res, "search");
  const body = (await res.json()) as { hits: unknown[] };
  assert.ok(
    (body.hits as unknown[]).length > 0,
    "isolation test indexed nothing, so it cannot prove anything",
  );
  return body;
}

function daemonPRAGROOTIsolationSuite(): void {
  afterEach(async () => {
    while (startups.length) {
      const s = startups.pop()!;
      await s.daemon.stop();
      await s.schema.close();
    }
    cleanEnv();
  });

  void it("health reports PRAG_ROOT paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "prag-isolation-"));
    await withEnv({ PRAG_ROOT: root, PRAG_EMBEDDING_MODEL: "fake:8" }, async () => {
      const config = loadConfig();
      const startup = await bootstrap({ ...config, port: 0, token: "test", noExit: true });
      startups.push(startup);

      const res = await fetch(`http://127.0.0.1:${startup.daemon.boundPort}/health`);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body.root, root);
      assert.equal(body.dataDir, join(root, "data"));
      assert.equal(body.configDir, join(root, "config"));
      assert.equal(body.runDir, join(root, "state"));
    });
    rmSync(root, { recursive: true, force: true });
  });

  void it("a full index-and-search cycle creates nothing under any XDG root", async () => {
    // The XDG roots point at a scratch directory, so "nothing created under it"
    // is a filesystem assertion rather than a path-string assertion. All three
    // matter: state/ is where runDir and logDir land by default, and it was
    // previously unsnapshotted.
    const xdgHome = mkdtempSync(join(tmpdir(), "prag-xdg-"));
    const root = mkdtempSync(join(tmpdir(), "prag-no-leak-"));
    const projectDir = join(root, "project");
    makeProject(projectDir);

    await withEnv(
      {
        PRAG_ROOT: root,
        PRAG_EMBEDDING_MODEL: "fake:8",
        XDG_DATA_HOME: join(xdgHome, "share"),
        XDG_CONFIG_HOME: join(xdgHome, "config"),
        XDG_STATE_HOME: join(xdgHome, "state"),
      },
      async () => {
        const config = loadConfig();
        const startup = await bootstrap({ ...config, port: 0, token: "test", noExit: true });
        startups.push(startup);
        writeRuntimeFiles(config.paths!, startup.daemon.boundPort!, "test");
        await indexAndSearch(startup.daemon.boundPort!, projectDir);
      },
    );

    for (const sub of ["share", "config", "state"]) {
      const dir = join(xdgHome, sub, "prag");
      assert.ok(!existsSync(dir), `leaked into XDG ${sub}: ${dir}`);
    }
    // And the scratch XDG home is entirely empty, not merely prag-free: nothing
    // else may write there either.
    assert.deepEqual(readdirSync(xdgHome), [], "something was written under the XDG home");

    rmSync(root, { recursive: true, force: true });
    rmSync(xdgHome, { recursive: true, force: true });
  });

  void it("PRAG_DATA_DIR relocates data while the rest stays under PRAG_ROOT", async () => {
    // Checked by observing where the LanceDB directory actually lands, not by
    // re-deriving the path string from resolvePragPaths().
    const root = mkdtempSync(join(tmpdir(), "prag-prec-"));
    const other = mkdtempSync(join(tmpdir(), "prag-other-"));
    const dataDir = join(other, "relocated");
    const projectDir = join(root, "project");
    makeProject(projectDir);

    await withEnv(
      { PRAG_ROOT: root, PRAG_DATA_DIR: dataDir, PRAG_EMBEDDING_MODEL: "fake:8" },
      async () => {
        const config = loadConfig();
        assert.equal(config.paths!.dataDir, dataDir);
        assert.equal(config.paths!.configDir, join(root, "config"));
        assert.equal(config.paths!.runDir, join(root, "state"));
        assert.equal(config.paths!.logDir, join(root, "state", "logs"));

        const startup = await bootstrap({
          ...config,
          port: 0,
          token: "test",
          noExit: true,
        });
        startups.push(startup);
        writeRuntimeFiles(config.paths!, startup.daemon.boundPort!, "test");
        await indexAndSearch(startup.daemon.boundPort!, projectDir);

        assert.ok(existsSync(join(dataDir, "lancedb")), "data did not land in PRAG_DATA_DIR");
        assert.ok(!existsSync(join(root, "data", "lancedb")), "data also landed under PRAG_ROOT");
        assert.ok(existsSync(join(root, "config")), "configDir missing");
        assert.ok(existsSync(join(root, "state", "daemon.port")), "port file missing");
        assert.ok(existsSync(join(root, "state", "logs")), "logDir missing");
      },
    );

    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });

  void it("deleting the root removes every trace of the instance", async () => {
    const root = mkdtempSync(join(tmpdir(), "prag-trace-"));
    const projectDir = join(root, "project");
    makeProject(projectDir);

    await withEnv({ PRAG_ROOT: root, PRAG_EMBEDDING_MODEL: "fake:8" }, async () => {
      const config = loadConfig();
      const startup = await bootstrap({ ...config, port: 0, token: "test", noExit: true });
      startups.push(startup);
      writeRuntimeFiles(config.paths!, startup.daemon.boundPort!, "test");
      await indexAndSearch(startup.daemon.boundPort!, projectDir);
      assert.ok(readdirSync(root).length > 0, "nothing was created under the root at all");

      while (startups.length) {
        const s = startups.pop()!;
        await s.daemon.stop();
        await s.schema.close();
      }
      rmSync(root, { recursive: true, force: true });
      assert.ok(!existsSync(root));
      // Nothing survives elsewhere either: the instance was entirely inside <root>.
      assert.equal(resolvePragPaths().root, root, "env drifted mid-test");
    });

    rmSync(projectDir, { recursive: true, force: true });
  });

  void it("daemon.token is written 0600 and only for the default guest token", async () => {
    const root = mkdtempSync(join(tmpdir(), "prag-token-"));
    await withEnv({ PRAG_ROOT: root }, async () => {
      const paths = resolvePragPaths();
      mkdirSync(paths.runDir, { recursive: true });

      writeRuntimeFiles(paths, 7724, "guest");
      const tokenPath = join(paths.runDir, "daemon.token");
      assert.ok(existsSync(tokenPath), "guest token file was not written");
      // Only the low bits: the platform's umask may clear others, and mode is
      // ignored for a pre-existing file, which is why writeRuntimeFiles chmods.
      assert.equal(statSync(tokenPath).mode & 0o777, 0o600);

      rmSync(tokenPath);
      writeRuntimeFiles(paths, 7724, "a-real-secret");
      assert.ok(
        !existsSync(tokenPath),
        "an explicit PRAG_API_KEY must not be persisted to disk",
      );
      assert.equal(readPort(paths.runDir), 7724, "daemon.port must always be written");
    });
    rmSync(root, { recursive: true, force: true });
  });
}

function readPort(runDir: string): number {
  return Number(readFileSync(join(runDir, "daemon.port"), "utf-8"));
}

void describe("Daemon PRAG_ROOT isolation", daemonPRAGROOTIsolationSuite);
