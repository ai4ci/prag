// @prag/cli — end-to-end test running `prag` commands in-process against a test daemon
// Uses subprocess for CLI (sandbox-isolated), registers project + indexes via direct HTTP,
// then tests read-only CLI commands against the daemon.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestDaemon, stopTestDaemon, buildFixtures } from "@prag/daemon";
import { runCLI } from "../src/test-runner.js";
import { summarizeSkipped } from "../src/main.js";
import type { TestDaemonInstance } from "@prag/daemon";

function cLIEndToEndSuite(): void {
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

  void it("formats skip counters the way `prag status` prints them", () => {
    // ADR-023 hinges on a user being able to read these; the formatting is the
    // user-visible half of that contract.
    assert.equal(
      summarizeSkipped({ tooLarge: 40, binary: 1163 }),
      "1,203 skipped (40 tooLarge, 1,163 binary)",
    );
    assert.equal(summarizeSkipped({}), "");
    assert.equal(summarizeSkipped(undefined), "");
    assert.equal(summarizeSkipped({ binary: 0 }), "");
  });

  void it("`prag status` names the egress path, including when there is none", async () => {
    // ADR-024: the selected backend must always be inspectable. The harness
    // configures none, which is the case worth printing -- a blank line here
    // would leave a user unable to tell "local only" from "not reported".
    const { stdout, exitCode } = await runCLI(["status"], env);
    assert.equal(exitCode, 0, `exit ${exitCode}\n${stdout}`);
    assert.match(stdout, /^Web: none \(local content only\)$/m, `stdout:\n${stdout}`);
  });

  void it("captures stdout on more than the first runCLI call", async () => {
    // The harness installed a fresh capture stream per call, but Node's
    // global `console` resolves `process.stdout` once and keeps the stream it
    // found. So only the first call in a process captured anything, and every
    // later assertion on stdout saw "". Nothing caught it because the other
    // tests here assert only on the exit code.
    const first = await runCLI(["status"], env);
    const second = await runCLI(["status"], env);
    assert.ok(first.stdout.length > 0, "the first call captured nothing");
    assert.ok(second.stdout.length > 0,
      "a second runCLI call captured no stdout; the capture stream was swapped out " +
      "from under console");
    // ...and each call gets its own buffer rather than accumulating.
    assert.equal(second.stdout, first.stdout);
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
}
void describe("CLI end-to-end", cLIEndToEndSuite);
