// @prag/daemon — PRAG_ROOT isolation test (ADR-019)
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { LanceDbSchema, FakeEmbeddingProvider } from "@prag/core";
import { Daemon } from "./daemon.js";

// Save original PRAG_* vars
const OENV: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("PRAG_")) {
      OENV[k] = process.env[k];
      delete process.env[k];
    }
  }
  delete process.env.XDG_DATA_HOME;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_STATE_HOME;
});

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("PRAG_")) delete process.env[k];
  }
  for (const [k, v] of Object.entries(OENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

void describe("Daemon PRAG_ROOT isolation", () => {
  let port = 19900;

  void it("health reports PRAG_ROOT paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "prag-isolation-"));
    process.env.PRAG_ROOT = root;

    const schema = new LanceDbSchema({
      dbPath: root,
      embeddingDim: 4,
      maxVectorUnitTokens: 512,
      modelMaxSeqLength: 512,
    });
    await schema.init();

    const p = port++;
    const daemon = new Daemon({ port: p, token: "test" });
    await daemon.start(schema, new FakeEmbeddingProvider(4));

    try {
      const res = await fetch(`http://127.0.0.1:${p}/health`);
      const body = await res.json() as Record<string, unknown>;

      assert.equal(body.root, root);
      assert.equal(body.dataDir, join(root, "data"));
      assert.equal(body.configDir, join(root, "config"));
      assert.equal(body.runDir, join(root, "state"));
    } finally {
      await daemon.stop();
      await schema.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("no paths leak to XDG when PRAG_ROOT is set", async () => {
    const root = mkdtempSync(join(tmpdir(), "prag-no-leak-"));
    process.env.PRAG_ROOT = root;

    // Snapshot XDG paths before and after
    const xdgData = join(tmpdir(), "xdg", "share", "prag");
    const xdgConfig = join(tmpdir(), "xdg", "config", "prag");
    process.env.XDG_DATA_HOME = join(tmpdir(), "xdg", "share");
    process.env.XDG_CONFIG_HOME = join(tmpdir(), "xdg", "config");

    const schema = new LanceDbSchema({
      dbPath: root,
      embeddingDim: 4,
      maxVectorUnitTokens: 512,
      modelMaxSeqLength: 512,
    });
    await schema.init();

    const p = port++;
    const daemon = new Daemon({ port: p, token: "test" });
    await daemon.start(schema, new FakeEmbeddingProvider(4));

    try {
      // Exercise the daemon a bit
      await fetch(`http://127.0.0.1:${p}/projects`, {
        headers: { Authorization: "Bearer test" },
      });

      assert.equal(existsSync(xdgData), false, "XDG data dir was created");
      assert.equal(existsSync(xdgConfig), false, "XDG config dir was created");
    } finally {
      await daemon.stop();
      await schema.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
