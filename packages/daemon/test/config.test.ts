// @prag/daemon — loadConfig() and the values it feeds the daemon.
//
// These knobs are the documented surface (env-and-storage-paths.md), so their
// precedence is the contract. Both bugs here were invisible to every other test
// because nothing else constructs a config.json.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/main.js";
import { DAEMON_VERSION } from "../src/daemon.js";

function loadConfigSuite(): void {
  const saved = { ...process.env };
  const roots: string[] = [];

  afterEach(() => {
    process.env = { ...saved };
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  /** PRAG_ROOT with a config.json containing `server` / `ingestion` fragments. */
  function rootWith(config: unknown): string {
    const root = mkdtempSync(join(tmpdir(), "prag-cfg-"));
    roots.push(root);
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(join(root, "config", "config.json"), JSON.stringify(config));
    return root;
  }

  void it("honours ingestion.workerPoolSize from config.json", () => {
    process.env.PRAG_ROOT = rootWith({ ingestion: { workerPoolSize: 4 } });
    delete process.env.PRAG_WORKER_POOL_SIZE;
    assert.equal(loadConfig().ingestion?.poolSize, 4);
  });

  void it("treats an explicit workerPoolSize of 0 as 'watching disabled'", () => {
    // env-and-storage-paths.md documents 0 as the off switch and daemon.ts:203
    // gates ingestion on `poolSize > 0`. With `||` chaining 0 was unreachable from
    // either knob, since 0 is falsy -- the pool silently stayed at 1.
    process.env.PRAG_ROOT = rootWith({ ingestion: { workerPoolSize: 0 } });
    delete process.env.PRAG_WORKER_POOL_SIZE;
    assert.equal(loadConfig().ingestion?.poolSize, 0);

    process.env.PRAG_WORKER_POOL_SIZE = "0";
    assert.equal(loadConfig().ingestion?.poolSize, 0);
  });

  void it("PRAG_WORKER_POOL_SIZE overrides config.json", () => {
    process.env.PRAG_ROOT = rootWith({ ingestion: { workerPoolSize: 4 } });
    process.env.PRAG_WORKER_POOL_SIZE = "2";
    assert.equal(loadConfig().ingestion?.poolSize, 2);
  });

  void it("defaults the pool to one worker with no config", () => {
    process.env.PRAG_ROOT = mkdtempSync(join(tmpdir(), "prag-cfg0-"));
    roots.push(process.env.PRAG_ROOT);
    delete process.env.PRAG_WORKER_POOL_SIZE;
    assert.equal(loadConfig().ingestion?.poolSize, 1);
  });

  void it("reports the package version, not a copy of it", () => {
    // ADR-016: /health `version` is the daemon's package semver, for diagnostics
    // only. It was a hardcoded literal, so it would have kept saying 0.1.0
    // forever -- exactly the stale bug report the field exists to prevent.
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    assert.equal(DAEMON_VERSION, pkg.version);
    assert.match(DAEMON_VERSION, /^\d+\.\d+\.\d+/);
  });
}

void describe("loadConfig", loadConfigSuite);
