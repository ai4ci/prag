// @prag/daemon — Test harness tests (ADR-019)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startTestDaemon, stopTestDaemon, buildFixtures } from "../src/test-harness.js";

function testHarnessSuite(): void {
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


  void it("does not touch process.env, so concurrent harnesses cannot collide", async () => {
    // The harness used to set PRAG_ROOT, await daemon.start() -- which yields --
    // and restore afterwards, so two overlapping starts could restore over each
    // other. ADR-019 requires the harness be safe to run concurrently, and
    // process.env is shared global state.
    const before = process.env.PRAG_ROOT;
    const sentinel = "/nonexistent/sentinel-root";
    process.env.PRAG_ROOT = sentinel;
    try {
      const inst = await startTestDaemon();
      try {
        assert.equal(process.env.PRAG_ROOT, sentinel,
          "the harness mutated PRAG_ROOT instead of passing paths explicitly");
        assert.notEqual(inst.root, sentinel);
        // ...and the daemon is rooted where the harness says, not at the sentinel.
        const health = await (await fetch(`${inst.baseUrl}/health`)).json() as { root: string };
        assert.equal(health.root, inst.root);
      } finally {
        await stopTestDaemon(inst);
      }
    } finally {
      if (before === undefined) delete process.env.PRAG_ROOT;
      else process.env.PRAG_ROOT = before;
    }
  });

  void it("starts several harnesses concurrently without crossing roots", async () => {
    const insts = await Promise.all([startTestDaemon(), startTestDaemon(), startTestDaemon()]);
    try {
      const roots = insts.map((i) => i.root);
      assert.equal(new Set(roots).size, 3, "two harnesses shared a root");
      assert.equal(new Set(insts.map((i) => i.port)).size, 3, "two harnesses shared a port");
      for (const inst of insts) {
        const health = await (await fetch(`${inst.baseUrl}/health`)).json() as { root: string };
        assert.equal(health.root, inst.root, "a daemon is serving another harness's root");
      }
    } finally {
      await Promise.all(insts.map(stopTestDaemon));
    }
  });

  void it("returns a daemon that is already answering /health", async () => {
    // No poll in the test: the harness owns readiness, so the first request a
    // test makes must not be a race.
    const inst = await startTestDaemon();
    try {
      const res = await fetch(`${inst.baseUrl}/health`);
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as { status: string }).status, "ok");
    } finally {
      await stopTestDaemon(inst);
    }
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
}
void describe("Test harness", testHarnessSuite);
