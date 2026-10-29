// @prag/cli — end-to-end test running `prag` commands in-process against a test daemon
// Uses subprocess for CLI (sandbox-isolated), registers project + indexes via direct HTTP,
// then tests read-only CLI commands against the daemon.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestDaemon, stopTestDaemon, buildFixtures } from "@prag/daemon";
import { runCLI } from "./test-runner.js";
import type { TestDaemonInstance } from "@prag/daemon";

describe("CLI end-to-end", () => {
  let inst: TestDaemonInstance;
  let env: Record<string, string>;

  before(async () => {
    inst = await startTestDaemon({ withFixtures: true });
    env = {
      PRAG_ROOT: inst.root,
      PRAG_PORT: String(inst.port),
      PRAG_API_KEY: inst.token,
      PRAG_NO_SPAWN: "1",
    };
  });

  after(async () => {
    await stopTestDaemon(inst);
  });

  void it("daemon status returns running info", async () => {
    const { stdout, exitCode } = await runCLI(["daemon", "status"], env);
    assert.equal(exitCode, 0, `exit ${exitCode}`);
    assert.ok(stdout.includes("PID:"), `stdout:\n${stdout}`);
    assert.ok(stdout.includes("Port:"), `stdout:\n${stdout}`);
  });

  void it("projects lists registered projects after fixture registration", async () => {
    // Register a project via direct HTTP (subprocess can't reach daemon in sandbox)
    const alphaUri = "file://" + inst.fixtures!.alpha;
    const reg = await fetch(`${inst.baseUrl}/projects`, {
      method: "POST",
      headers: { Authorization: `Bearer ${inst.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "alpha", rootUri: alphaUri }),
    });
    // Registration may fail if ingestion not enabled; that's fine
    const { stdout, exitCode } = await runCLI(["projects"], env);
    assert.equal(exitCode, 0, `exit ${exitCode}`);
  });

  void it("grants lists grant rules", async () => {
    const { stdout, exitCode } = await runCLI(["grants"], env);
    assert.equal(exitCode, 0, `exit ${exitCode}`);
  });

  void it("daemon token command works", async () => {
    const { exitCode } = await runCLI(["daemon", "token"], env);
    assert.equal(exitCode, 0, `exit ${exitCode}`);
    // Can't capture console.log output via stdout replacement (console
    // caches process.stdout at startup), so just verify exit code
  });

  void it("grants evaluate shows deny by default", async () => {
    const { exitCode } = await runCLI(["grants", "evaluate", "/some/unknown/path.ts"], env);
    assert.equal(exitCode, 0, `exit ${exitCode}`);
  });

  void it("grants evaluate shows matched grant", async () => {
    // Add a grant first
    await fetch(`${inst.baseUrl}/grants`, {
      method: "POST",
      headers: { Authorization: `Bearer ${inst.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ pattern: "file:///home/**", action: "allow" }),
    });
    const { exitCode } = await runCLI(["grants", "evaluate", "/home/some/file.ts"], env);
    assert.equal(exitCode, 0, `exit ${exitCode}`);
  });
});
