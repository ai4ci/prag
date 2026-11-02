// @prag/cli — DaemonClient tests against a test-harness daemon

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { startTestDaemon, stopTestDaemon } from "@prag/daemon";
import { DaemonClient } from "../src/daemon-client.js";
import type { TestDaemonInstance } from "@prag/daemon";

function daemonClientSuite(): void {
  let inst: TestDaemonInstance;
  let client: DaemonClient;

  before(async () => {
    inst = await startTestDaemon({ withFixtures: true });
    client = new DaemonClient(inst.baseUrl, inst.token);
  });

  after(async () => {
    await stopTestDaemon(inst);
  });

  void it("health returns daemon info", async () => {
    const h = await client.health();
    assert.ok(h, "health should return a response");
    assert.equal(h!.service, "prag-daemon");
    assert.equal(h!.apiVersion, 1);
    assert.ok(h!.pid > 0);
    assert.equal(h!.root, inst.root);
  });

  void it("health returns null when daemon is unreachable", async () => {
    const deadClient = new DaemonClient("http://127.0.0.1:19999", "test");
    const h = await deadClient.health();
    assert.equal(h, null);
  });

  void it("checkHealth raises NO_DAEMON for unreachable daemon", async () => {
    const deadClient = new DaemonClient("http://127.0.0.1:19998", "test");
    await assert.rejects(
      () => deadClient.checkHealth(),
      (err: unknown) => (err as { code: string }).code === "NO_DAEMON",
    );
  });

  void it("checkApiVersion passes on match", () => {
    const h = { apiVersion: 1, service: "prag-daemon" } as ReturnType<DaemonClient["checkHealth"]> extends Promise<infer T> ? T : never;
    client.checkApiVersion(h as never); // Should not throw
  });

  void it("checkApiVersion throws on mismatch", () => {
    const h = { apiVersion: 99, service: "prag-daemon", pid: 1, port: 7724, version: "0.1.0", uptime: 1, root: null, dataDir: "/tmp", configDir: "/tmp", runDir: "/tmp", status: "ok" };
    assert.throws(
      () => client.checkApiVersion(h),
      (err: unknown) => (err as { code: string }).code === "API_VERSION_MISMATCH",
    );
  });

  void it("search returns results", async () => {
    const result = await client.search({ query: "function", limit: 3 });
    assert.ok(Array.isArray(result.hits));
  });

  void it("listGrants returns empty array initially", async () => {
    const grants = await client.listGrants();
    assert.ok(Array.isArray(grants));
  });

  void it("listProjects returns registered projects", async () => {
    const projects = await client.listProjects();
    assert.ok(Array.isArray(projects));
    // test-harness doesn't register any by default
  });

  void it("sync completes without error", async () => {
    const result = await client.sync();
    assert.ok(result.ok);
  });

  void it("prune completes without gcChunks", async () => {
    const result = await client.prune(false);
    assert.equal(typeof result.prunedBranches, "number");
    assert.equal(typeof result.purgedChunks, "number");
  });

  void it("inferProjectId returns null when no projects registered", async () => {
    const id = await client.inferProjectId();
    assert.equal(id, null);
  });

  void it("shutdown stops the daemon (noExit mode)", async () => {
    const shutdownInst = await startTestDaemon();
    try {
      const shutdownClient = new DaemonClient(shutdownInst.baseUrl, shutdownInst.token);
      assert.ok(await shutdownClient.health(), "health before shutdown");

      // Daemon is in noExit mode — shutdown closes the server but
      // does not call process.exit(0), so the test runner stays alive.
      await shutdownClient.shutdown();

      // Wait for server closeAllConnections + setImmediate to run
      await new Promise((r) => setTimeout(r, 200));
      const h = await shutdownClient.health();
      assert.equal(h, null, "health should return null after shutdown");
    } finally {
      await stopTestDaemon(shutdownInst);
    }
  });

  void it("pause sets project to paused status", async () => {
    const pInst = await startTestDaemon();
    try {
      const c = new DaemonClient(pInst.baseUrl, pInst.token);
      const projectId = "test-project-1";

      // Insert a project directly into the DB (ingestion not enabled in test harness)
      const { upsertProjects } = await import("@prag/core");
      const projectsTbl = pInst.schema.table("projects");
      await upsertProjects(projectsTbl, [{
        projectId,
        rootUri: "file:///tmp/test-pause-proj",
        name: projectId,
        isGit: false,
        defaultCooldownSeconds: 60,
        status: "active",
        registeredAt: new Date(),
        lastSyncedAt: null,
      }]);

      // Pause and check status
      await c.pause(projectId);
      const after = await c.listProjects();
      const paused = after.find((p) => p.projectId === projectId);
      assert.equal(paused?.status, "paused");

      // Resume and check status
      await c.resume(projectId);
      const resumed = await c.listProjects();
      const active = resumed.find((p) => p.projectId === projectId);
      assert.equal(active?.status, "active");
    } finally {
      await stopTestDaemon(pInst);
    }
  });
}
void describe("DaemonClient", daemonClientSuite);
