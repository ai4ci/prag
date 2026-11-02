// @prag/daemon — the fake embedding provider reached through the real entry point
//
// task:deterministic-embedding-provider.md requires that `PRAG_EMBEDDING_MODEL=fake:384`
// and `embedding.model` actually select the provider, that it is pinned in the ADR-015
// sidecar like any real model, and that switching between fake and real is refused rather
// than silently mixing two embedding spaces. The provider's own unit tests cannot show any
// of that: they construct it directly, so they pass even when no process reads config.
// Everything here goes through `loadConfig()`/`bootstrap()`, the only production path from a
// model string to a running daemon.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  FakeEmbeddingProvider,
  registerProvider,
  resolveEmbeddingModel,
  writeEmbeddingSidecar,
  type EmbeddingProvider,
  type PragPaths,
} from "@prag/core";
import {
  EmbeddingMismatchError,
  bootstrap,
  dbPathFor,
  loadConfig,
  type Startup,
} from "../src/main.js";
import type { DaemonConfig } from "../src/daemon.js";

const REAL_MODEL = "onnx:Xenova/bge-small-en-v1.5";

function pathsFor(root: string): PragPaths {
  return {
    root,
    dataDir: join(root, "data"),
    configDir: join(root, "config"),
    runDir: join(root, "state"),
    logDir: join(root, "state", "logs"),
  };
}

function fakeConfig(root: string, model = "fake:64"): DaemonConfig {
  return {
    port: 0,
    token: "test-fake",
    noExit: true,
    paths: pathsFor(root),
    ingestion: { poolSize: 1, cooldownMs: 50 },
    embeddingModel: model,
  };
}

/**
 * A provider carrying a real model's identity without its weights, so the ADR-015
 * gate can be exercised against the default model id. Registered under the exact id
 * — the registry matches prefixes, so this wins over the `onnx:` factory that would
 * try to download 775MB (ADR-019: the suite must never need them).
 */
class StandInRealProvider implements EmbeddingProvider {
  readonly model = REAL_MODEL;
  readonly dim = 384;
  readonly maxSeqLength = 512;
  static loads = 0;
  async load(): Promise<void> {
    StandInRealProvider.loads++;
  }
  async embed(text: string): Promise<Float32Array> {
    return new FakeEmbeddingProvider(384).embed(text);
  }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return new FakeEmbeddingProvider(384).embedBatch(texts);
  }
}

registerProvider(REAL_MODEL, () => new StandInRealProvider());

/**
 * Where a `Socket.connect()` call was headed. Node's internals pass the options
 * wrapped in an array here, so the walk is recursive.
 */
function describeConnectTarget(arg: unknown): string {
  if (Array.isArray(arg)) return arg.map(describeConnectTarget).join(",");
  if (typeof arg === "string") return `path=${arg}`;
  if (arg && typeof arg === "object") {
    const o = arg as { host?: string; hostname?: string; path?: string; port?: number | string };
    return `${o.host ?? o.hostname ?? o.path ?? "?"}:${o.port ?? ""}`;
  }
  return "<local>";
}

async function indexOneFile(startup: Startup, root: string, projectId: string): Promise<void> {
  const port = startup.daemon.boundPort!;
  const dir = join(root, "src");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "greeting.ts"), 'export const hi = "hello world";\n');

  const headers = {
    "Content-Type": "application/json",
    Authorization: "Bearer test-fake",
  };
  const reg = await fetch(`http://127.0.0.1:${port}/projects`, {
    method: "POST",
    headers,
    body: JSON.stringify({ projectId, rootUri: dir }),
  });
  assert.equal(reg.status, 200, await reg.text());

  const headersOnly = { Authorization: "Bearer test-fake" };
  const sync = await fetch(`http://127.0.0.1:${port}/sync`, {
    method: "POST",
    headers: { ...headersOnly, "Content-Type": "application/json" },
    body: JSON.stringify({ projectId }),
  });
  assert.equal(sync.status, 200, await sync.text());

  const search = await fetch(`http://127.0.0.1:${port}/search`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: "hello world", projectId, mode: "fts" }),
  });
  assert.equal(search.status, 200);
  const body = (await search.json()) as { hits: Array<{ uri: string }> };
  assert.ok(body.hits.length > 0, "the cycle must actually index and retrieve");
}

function fakeProviderEntryPointSuite(): void {
  describe("fake provider through the daemon entry point", () => {
  const roots: string[] = [];
  const startups: Startup[] = [];

  const freshRoot = (): string => {
    const root = mkdtempSync(join(tmpdir(), "prag-fake-entry-"));
    roots.push(root);
    return root;
  };

  after(async () => {
    for (const s of startups) {
      await s.daemon.stop().catch(() => {});
      await s.schema.close().catch(() => {});
    }
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  void it("PRAG_EMBEDDING_MODEL and embedding.model both select the provider", () => {
    const root = freshRoot();
    mkdirSync(pathsFor(root).configDir, { recursive: true });
    writeFileSync(
      join(pathsFor(root).configDir, "config.json"),
      JSON.stringify({ embedding: { model: "fake:128" } }),
    );

    const prevRoot = process.env.PRAG_ROOT;
    const prevModel = process.env.PRAG_EMBEDDING_MODEL;
    process.env.PRAG_ROOT = root;
    try {
      delete process.env.PRAG_EMBEDDING_MODEL;
      assert.equal(loadConfig().embeddingModel, "fake:128", "config.json is honoured");

      process.env.PRAG_EMBEDDING_MODEL = "fake:32";
      assert.equal(
        loadConfig().embeddingModel,
        "fake:32",
        "the env var overrides the file, as documented",
      );

      // And the resolved string yields the built-in provider, not a stand-in.
      const provider = resolveEmbeddingModel(loadConfig().embeddingModel!);
      assert.ok(provider instanceof FakeEmbeddingProvider);
      assert.equal(provider.dim, 32);
    } finally {
      if (prevRoot === undefined) delete process.env.PRAG_ROOT;
      else process.env.PRAG_ROOT = prevRoot;
      if (prevModel === undefined) delete process.env.PRAG_EMBEDDING_MODEL;
      else process.env.PRAG_EMBEDDING_MODEL = prevModel;
    }
  });

  void it("bootstrap runs on fake:64 and pins it in the sidecar", async () => {
    const root = freshRoot();
    const startup = await bootstrap(fakeConfig(root));
    startups.push(startup);

    assert.equal(startup.provider.model, "fake:64");
    assert.equal(startup.provider.dim, 64);

    // Pinned exactly like a real model (requirement 4): the ADR-015 gate reads this file.
    const sidecar = JSON.parse(
      readFileSync(join(dbPathFor(startup.config.paths!), ".embedding-model.json"), "utf-8"),
    ) as Record<string, unknown>;
    assert.equal(sidecar.model, "fake:64");
    assert.equal(sidecar.dim, 64);
    assert.equal(typeof sidecar.pinnedAt, "string");

    await indexOneFile(startup, root, "fake-sidecar");
  });

  void it("indexing the same fixture twice yields identical hashes and vectors", async () => {
    // Two independent daemons and databases: what re-running the daemon must produce.
    // chunkHash is a content hash, so it agrees trivially; the vectors are the claim.
    const read = async (s: Startup) => {
      const pool = (await s.schema
        .table("chunks_pool")
        .query()
        .limit(1000)
        .toArray()) as Array<{ chunkHash: string }>;
      const vectors = (await s.schema
        .table("vector_pool")
        .query()
        .limit(1000)
        .toArray()) as Array<{ chunkHash: string; vector: ArrayLike<number> }>;
      const byHash = new Map(vectors.map((v) => [v.chunkHash, Array.from(v.vector)]));
      return pool
        .map((c) => c.chunkHash)
        .sort()
        .map((h) => [h, byHash.get(h)] as const);
    };

    const a = await bootstrap(fakeConfig(freshRoot()));
    startups.push(a);
    const b = await bootstrap(fakeConfig(freshRoot()));
    startups.push(b);

    // Same fixture text into both: the files live in different directories, so only
    // the chunk content (and therefore the embedding) is comparable.
    await indexOneFile(a, roots[roots.length - 2], "det-a");
    await indexOneFile(b, roots[roots.length - 1], "det-b");

    const rowsA = await read(a);
    const rowsB = await read(b);
    assert.ok(rowsA.length > 0 && rowsB.length > 0, "both must have indexed");
    assert.deepEqual(rowsB, rowsA);
    assert.equal(rowsA[0][1]?.length, 64);
  });

  void it("refuses an index pinned to another model, in both directions", async () => {
    const pinned = async (root: string, model: string) => {
      writeEmbeddingSidecar(dbPathFor(pathsFor(root)), {
        model,
        dim: model === REAL_MODEL ? 384 : 64,
        maxSeqLength: 512,
        pinnedAt: "2026-01-01T00:00:00.000Z",
      });
    };

    // Real index, fake configured: the case that would silently mix embedding spaces.
    const rootA = freshRoot();
    await pinned(rootA, REAL_MODEL);
    await assert.rejects(
      () => bootstrap(fakeConfig(rootA)),
      (err: unknown) => {
        assert.ok(err instanceof EmbeddingMismatchError, `got ${String(err)}`);
        assert.equal(err.indexModel, REAL_MODEL);
        assert.equal(err.requestedModel, "fake:64");
        // The remedy must be in the message: this is the one failure the user can act
        // on, and the daemon stays up in degraded mode precisely so they can act.
        assert.match(err.message, /prag reembed/);
        return true;
      },
    );

    // Fake index, real configured: the reverse, which is what a user who removes
    // PRAG_EMBEDDING_MODEL after a smoke test hits.
    const rootB = freshRoot();
    await pinned(rootB, "fake:64");
    await assert.rejects(
      () => bootstrap(fakeConfig(rootB, REAL_MODEL)),
      (err: unknown) =>
        err instanceof EmbeddingMismatchError &&
        err.indexModel === "fake:64" &&
        err.requestedModel === REAL_MODEL,
    );
  });

  void it("refuses before loading weights, so a doomed start costs nothing", async () => {
    // The gate's position is the requirement: after load() the user has paid a 130MB
    // download for a daemon that will refuse to serve them.
    const before = StandInRealProvider.loads;
    const root = freshRoot();
    // Pinned to the fake, started with the real model: load() is where the real
    // model's weights would be fetched, so the gate has to fire before it.
    writeEmbeddingSidecar(dbPathFor(pathsFor(root)), {
      model: "fake:64",
      dim: 64,
      maxSeqLength: 512,
      pinnedAt: "2026-01-01T00:00:00.000Z",
    });
    await assert.rejects(
      () => bootstrap(fakeConfig(root, REAL_MODEL)),
      EmbeddingMismatchError,
    );
    assert.equal(StandInRealProvider.loads, before, "mismatch must be caught before load()");
  });

  void it("a full fake cycle makes zero outbound connections", async () => {
    // local-first-enforcement.md wants this assertion; fake is the only provider that
    // can satisfy it on a machine with no cached model. Patched on Socket.prototype
    // rather than on the net module: ESM namespace objects are sealed, and every HTTP
    // client — undici included — reaches TCP through this one method.
    const attempted: string[] = [];
    const proto = Socket.prototype as unknown as {
      connect: (...args: never[]) => Socket;
    };
    const real = proto.connect;
    proto.connect = function (this: Socket, ...args: never[]) {
      attempted.push(describeConnectTarget(args[0]));
      return real.apply(this, args);
    } as typeof proto.connect;

    try {
      const startup = await bootstrap(fakeConfig(freshRoot()));
      startups.push(startup);
      await indexOneFile(startup, roots[roots.length - 1], "fake-no-net");

      // Loopback to the daemon under test is not "outbound"; anything else is.
      const external = attempted.filter(
        (a) => !a.includes("127.0.0.1") && !a.includes("::1") && !a.includes("localhost"),
      );
      assert.deepEqual(external, [], `reached the network: ${external.join(", ")}`);
    } finally {
      proto.connect = real;
    }
  });
  });
}
void describe("fake provider entry point", fakeProviderEntryPointSuite);
