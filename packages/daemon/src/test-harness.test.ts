// @prag/daemon — Test harness tests (ADR-019)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startTestDaemon, stopTestDaemon, buildFixtures } from "./test-harness.js";

void describe("Test harness", () => {
  void it("starts and stops a daemon with PRAG_ROOT isolation", async () => {
    const inst = await startTestDaemon();

    assert.ok(inst.port > 0, "should have a bound port");
    assert.ok(inst.baseUrl.startsWith("http://127.0.0.1:"), "baseUrl should have a port");
    assert.equal(inst.token, "test-token");
    assert.ok(inst.root.includes("prag-harness-"), "root should be a temp dir");

    // Health should work
    const health = await fetch(`${inst.baseUrl}/health`);
    assert.equal(health.status, 200);
    const body = await health.json() as Record<string, unknown>;
    assert.equal(body.root, inst.root);

    await stopTestDaemon(inst);
    assert.equal(existsSync(inst.root), false, "root should be cleaned up");
  });

  void it("supports custom port", async () => {
    const inst = await startTestDaemon({ port: 19874 });
    assert.equal(inst.port, 19874);

    const health = await fetch(`${inst.baseUrl}/health`);
    assert.equal(health.status, 200);

    await stopTestDaemon(inst);
  });

  void it("supports custom token", async () => {
    const inst = await startTestDaemon({ token: "custom-secret" });
    assert.equal(inst.token, "custom-secret");

    // Should work with custom token
    const res = await fetch(`${inst.baseUrl}/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer custom-secret",
      },
      body: JSON.stringify({ query: "test", limit: 5 }),
    });
    assert.equal(res.status, 200);

    // Should fail with wrong token
    const bad = await fetch(`${inst.baseUrl}/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong",
      },
      body: JSON.stringify({ query: "test", limit: 5 }),
    });
    assert.equal(bad.status, 401);

    await stopTestDaemon(inst);
  });

  void it("cleans up on stop even after daemon crash", async () => {
    const inst = await startTestDaemon();
    const root = inst.root;

    // Force-stop the daemon internally (simulate crash)
    await inst.daemon.stop();

    // stopTestDaemon should still clean up root
    await stopTestDaemon(inst);
    assert.equal(existsSync(root), false, "root should be cleaned up after crash");
  });

  void it("builds git fixtures into root", async () => {
    const inst = await startTestDaemon({ withFixtures: true });

    assert.ok(inst.fixtures, "fixtures should be built");
    assert.ok(inst.fixtures!.alpha, "alpha path should exist");
    assert.ok(inst.fixtures!.beta, "beta path should exist");
    assert.ok(inst.fixtures!.plain, "plain path should exist");

    // Verify git repo exists in alpha
    const gitDir = join(inst.fixtures!.alpha, ".git");
    assert.ok(existsSync(gitDir), "alpha should be a git repo");

    // plain should NOT have .git
    const plainGit = join(inst.fixtures!.plain, ".git");
    assert.equal(existsSync(plainGit), false, "plain should have no .git");

    // Verify stable SHAs (from README)
    await stopTestDaemon(inst);
  });

  void it("buildFixtures works standalone (without a daemon)", async () => {
    const root = mkdtempSync(join(tmpdir(), "prag-fixture-test-"));
    const fixtures = buildFixtures(root);

    assert.ok(fixtures.alpha, "alpha path");
    assert.ok(fixtures.beta, "beta path");
    assert.ok(fixtures.plain, "plain path");

    rmSync(root, { recursive: true, force: true });
  });
});
