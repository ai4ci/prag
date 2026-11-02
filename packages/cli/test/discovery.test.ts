// @prag/cli — how the CLI locates a daemon it did not spawn.
//
// These are about the *documented* knobs (env-and-storage-paths.md): a reader who
// sets `server.port` in config.json gets a daemon on that port, because
// `loadConfig()` reads the file. The client must use the same precedence or every
// command reports "daemon not running" against a daemon that is running.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DaemonClient } from "../src/daemon-client.js";

function daemonDiscoverySuite(): void {
  const saved = { ...process.env };
  const roots: string[] = [];

  afterEach(() => {
    process.env = { ...saved };
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  /** An instance root whose config.json sets server.port; returns its PRAG_ROOT. */
  function rootWithConfig(port: number): string {
    const root = mkdtempSync(join(tmpdir(), "prag-port-"));
    roots.push(root);
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(
      join(root, "config", "config.json"),
      JSON.stringify({ server: { port } }),
    );
    return root;
  }

  void it("reads server.port from config.json when PRAG_PORT is unset", () => {
    process.env.PRAG_ROOT = rootWithConfig(8123);
    delete process.env.PRAG_PORT;
    assert.equal(new DaemonClient().baseUrl, "http://127.0.0.1:8123");
  });

  void it("PRAG_PORT overrides config.json, matching the daemon", () => {
    process.env.PRAG_ROOT = rootWithConfig(8123);
    process.env.PRAG_PORT = "9321";
    assert.equal(new DaemonClient().baseUrl, "http://127.0.0.1:9321");
  });

  void it("falls back to the default port with no config file at all", () => {
    process.env.PRAG_ROOT = mkdtempSync(join(tmpdir(), "prag-empty-"));
    roots.push(process.env.PRAG_ROOT);
    delete process.env.PRAG_PORT;
    assert.equal(new DaemonClient().baseUrl, "http://127.0.0.1:7724");
  });

  void it("a malformed config.json does not stop `prag status` running", () => {
    // The daemon treats this as a hard error (loadPragConfig is deliberately
    // strict). The client is read-only diagnostics: report on the default port
    // rather than throwing before it has said anything.
    const root = mkdtempSync(join(tmpdir(), "prag-bad-"));
    roots.push(root);
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(join(root, "config", "config.json"), "{not json");
    process.env.PRAG_ROOT = root;
    delete process.env.PRAG_PORT;
    assert.equal(new DaemonClient().baseUrl, "http://127.0.0.1:7724");
  });

  void it("an explicit baseUrl wins over both knobs", () => {
    process.env.PRAG_ROOT = rootWithConfig(8123);
    process.env.PRAG_PORT = "9321";
    assert.equal(
      new DaemonClient("http://127.0.0.1:7724").baseUrl,
      "http://127.0.0.1:7724",
    );
  });
}

void describe("CLI daemon discovery", daemonDiscoverySuite);
