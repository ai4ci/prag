import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolvePragPaths } from "./paths.js";

// Save originals to restore
const OENV = { ...process.env };

function setEnv(k: string, v: string | undefined) {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

beforeEach(() => {
  // Clear all PRAG_* vars before each test
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("PRAG_")) delete process.env[k];
  }
  // Clear XDG overrides for determinism
  delete process.env.XDG_DATA_HOME;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_STATE_HOME;
});

afterEach(() => {
  // Restore original env
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("PRAG_")) delete process.env[k];
  }
  for (const [k, v] of Object.entries(OENV)) {
    if (k.startsWith("PRAG_") || k.startsWith("XDG_")) {
      process.env[k] = v;
    }
  }
});

void describe("resolvePragPaths", () => {
  const xdgData = join(homedir(), ".local", "share", "prag");
  const xdgConfig = join(homedir(), ".config", "prag");
  const xdgState = join(homedir(), ".local", "state", "prag");
  const xdgLogs = join(xdgState, "logs");

  void it("returns XDG defaults when no PRAG_ vars are set", () => {
    const p = resolvePragPaths();
    assert.equal(p.root, "");
    assert.equal(p.dataDir, xdgData);
    assert.equal(p.configDir, xdgConfig);
    assert.equal(p.runDir, xdgState);
    assert.equal(p.logDir, xdgLogs);
  });

  void it("derives all four dirs from PRAG_ROOT", () => {
    setEnv("PRAG_ROOT", "/tmp/prag-test");
    const p = resolvePragPaths();
    assert.equal(p.root, "/tmp/prag-test");
    assert.equal(p.dataDir, "/tmp/prag-test/data");
    assert.equal(p.configDir, "/tmp/prag-test/config");
    assert.equal(p.runDir, "/tmp/prag-test/state");
    assert.equal(p.logDir, "/tmp/prag-test/state/logs");
  });

  void it("explicit XDG variable overrides PRAG_ROOT for that category", () => {
    setEnv("PRAG_ROOT", "/tmp/prag-test");
    setEnv("PRAG_DATA_DIR", "/custom/data");
    const p = resolvePragPaths();
    assert.equal(p.dataDir, "/custom/data");
    // Other categories still derive from PRAG_ROOT
    assert.equal(p.configDir, "/tmp/prag-test/config");
    assert.equal(p.runDir, "/tmp/prag-test/state");
    assert.equal(p.logDir, "/tmp/prag-test/state/logs");
  });

  void it("explicit variable overrides XDG default when no PRAG_ROOT", () => {
    setEnv("PRAG_DATA_DIR", "/explicit/data");
    const p = resolvePragPaths();
    assert.equal(p.dataDir, "/explicit/data");
    assert.equal(p.configDir, xdgConfig);
    assert.equal(p.runDir, xdgState);
  });

  void it("never falls back to XDG when PRAG_ROOT is set and a category is unset", () => {
    // Without the redirect, an unset category must NOT return XDG paths
    setEnv("PRAG_ROOT", "/sandbox");
    const p = resolvePragPaths();
    assert.ok(!p.dataDir.includes(".local"), `dataDir leaked to XDG: ${p.dataDir}`);
    assert.ok(!p.configDir.includes(".config"), `configDir leaked to XDG: ${p.configDir}`);
    assert.ok(!p.runDir.includes(".local"), `runDir leaked to XDG: ${p.runDir}`);
    assert.ok(!p.logDir.includes(".local"), `logDir leaked to XDG: ${p.logDir}`);
    assert.equal(p.dataDir, "/sandbox/data");
    assert.equal(p.configDir, "/sandbox/config");
    assert.equal(p.runDir, "/sandbox/state");
    assert.equal(p.logDir, "/sandbox/state/logs");
  });

  void it("uses XDG_DATA_HOME when set", () => {
    setEnv("XDG_DATA_HOME", "/xdg/data");
    const p = resolvePragPaths();
    assert.ok(p.dataDir.startsWith("/xdg/data"));
  });

  void it("all four explicit vars override both PRAG_ROOT and XDG", () => {
    setEnv("PRAG_ROOT", "/root");
    setEnv("PRAG_DATA_DIR", "/d");
    setEnv("PRAG_CONFIG_DIR", "/c");
    setEnv("PRAG_RUN_DIR", "/r");
    setEnv("PRAG_LOG_DIR", "/l");
    const p = resolvePragPaths();
    assert.equal(p.dataDir, "/d");
    assert.equal(p.configDir, "/c");
    assert.equal(p.runDir, "/r");
    assert.equal(p.logDir, "/l");
    assert.equal(p.root, "/root");
  });
});
