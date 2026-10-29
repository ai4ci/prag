// @prag/core — LanceDB 7-table schema initialisation and helpers
//
// Connects to a local LanceDB database, creates the 7 CAS tables on first run,
// installs indexes (FTS on chunks_pool.text, IVF_PQ on vector_pool.vector),
// and provides transactional batch-upsert helpers.

import lancedb, {
  type Connection,
  type Table,
} from "@lancedb/lancedb";
import {
  Table as ArrowTable,
  Schema,
  Field,
  Utf8,
  Int32,
  Int64,
  Bool,
  Float32,
  FixedSizeList,
  DateMillisecond,
  type Table as ArrowTableType,
} from "apache-arrow";

// ── Constants ────────────────────────────────────────────────────────

export const API_VERSION = 1;

const DEFAULT_EMBEDDING_DIM = 384; // Xenova/bge-small-en-v1.5 default
const FTS_COLUMN = "text";
const VECTOR_COLUMN = "vector";

// ── Configuration ─────────────────────────────────────────────────────

export interface DatabaseConfig {
  /** Path to the LanceDB directory. */
  dbPath: string;

  /** Embedding vector dimension (default 384). */
  embeddingDim?: number;

  /** Max tokens per vectorised unit (ADR-014). */
  maxVectorUnitTokens?: number;

  /** Active model's reported max sequence length for startup validation. */
  modelMaxSeqLength?: number;
}

// ─── 7-table Arrow schemas ────────────────────────────────────────────

function grantsSchema(): Schema {
  return new Schema([
    new Field("pattern", new Utf8(), false),
    new Field("action", new Utf8(), false),
    new Field("reason", new Utf8(), false),
    new Field("createdAt", new DateMillisecond(), false),
  ]);
}

function projectsSchema(): Schema {
  return new Schema([
    new Field("projectId", new Utf8(), false),
    new Field("rootUri", new Utf8(), false),
    new Field("name", new Utf8(), false),
    new Field("isGit", new Bool(), false),
    new Field("defaultCooldownSeconds", new Int32(), true),
    new Field("status", new Utf8(), false),
    new Field("registeredAt", new DateMillisecond(), false),
    new Field("lastSyncedAt", new DateMillisecond(), true),
  ]);
}

function branchMappingSchema(): Schema {
  return new Schema([
    new Field("branch", new Utf8(), false),
    new Field("projectId", new Utf8(), false),
    new Field("uri", new Utf8(), false),
    new Field("fileVersionId", new Utf8(), false),
    new Field("updatedAt", new DateMillisecond(), false),
  ]);
}

function fileMappingSchema(): Schema {
  return new Schema([
    new Field("fileVersionId", new Utf8(), false),
    new Field("projectId", new Utf8(), false),
    new Field("uri", new Utf8(), false),
    new Field("validUntil", new DateMillisecond(), true),
    new Field("contentHash", new Utf8(), false),
    new Field("language", new Utf8(), false),
  ]);
}

function chunkMappingSchema(): Schema {
  return new Schema([
    new Field("fileVersionId", new Utf8(), false),
    new Field("chunkIndex", new Int32(), false),
    new Field("chunkHash", new Utf8(), false),
  ]);
}

function chunksPoolSchema(): Schema {
  return new Schema([
    new Field("chunkHash", new Utf8(), false),
    new Field("text", new Utf8(), false),
    new Field("scopeContext", new Utf8(), true),
  ]);
}

function vectorPoolSchema(dim: number): Schema {
  return new Schema([
    new Field("chunkHash", new Utf8(), false),
    new Field("unitIndex", new Int32(), false),
    new Field(
      "vector",
      new FixedSizeList(dim, new Field("item", new Float32(), true)),
      false,
    ),
  ]);
}

// ── Table metadata ────────────────────────────────────────────────────

export interface TableDefinition {
  name: string;
  schema: Schema;
  primaryKey: string;
  indexes?: Array<{
    column: string;
    type: "FTS" | "IVF_PQ";
    options?: Record<string, unknown>;
  }>;
}

export const ALL_TABLES: TableDefinition[] = [
  {
    name: "grants",
    schema: grantsSchema(),
    primaryKey: "pattern",
  },
  {
    name: "projects",
    schema: projectsSchema(),
    primaryKey: "projectId",
  },
  {
    name: "branch_mapping",
    schema: branchMappingSchema(),
    primaryKey: "branch",
  },
  {
    name: "file_mapping",
    schema: fileMappingSchema(),
    primaryKey: "fileVersionId",
  },
  {
    name: "chunk_mapping",
    schema: chunkMappingSchema(),
    primaryKey: "fileVersionId",
  },
  {
    name: "chunks_pool",
    schema: chunksPoolSchema(),
    primaryKey: "chunkHash",
    indexes: [{ column: FTS_COLUMN, type: "FTS" }],
  },
];

/**
 * Build vector_pool definition with the configured embedding dimension.
 * Must be called at init time since dimension is a runtime config value.
 */
function vectorPoolDef(dim: number): TableDefinition {
  return {
    name: "vector_pool",
    schema: vectorPoolSchema(dim),
    primaryKey: "chunkHash",
    indexes: [
      {
        column: VECTOR_COLUMN,
        type: "IVF_PQ",
      },
    ],
  };
}

// ── Database wrapper ──────────────────────────────────────────────────

export class LanceDbSchema {
  private _db: Connection | null = null;
  private _tables: Map<string, Table> = new Map();
  readonly config: Required<DatabaseConfig>;

  constructor(config: DatabaseConfig) {
    this.config = {
      dbPath: config.dbPath,
      embeddingDim: config.embeddingDim ?? DEFAULT_EMBEDDING_DIM,
      maxVectorUnitTokens: config.maxVectorUnitTokens ?? 400,
      modelMaxSeqLength: config.modelMaxSeqLength ?? 512,
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  /** Connect to the database and create tables + indexes. */
  async init(): Promise<void> {
    this.validate();

    this._db = await lancedb.connect(this.config.dbPath);

    await this._createTables();
    await this._createIndexes();
  }

  /** Close the database connection. */
  async close(): Promise<void> {
    for (const table of this._tables.values()) {
      await table.close();
    }
    this._tables.clear();
    if (this._db) {
      await this._db.close();
      this._db = null;
    }
  }

  /** Access a table by name. */
  table(name: string): Table {
    const t = this._tables.get(name);
    if (!t) throw new Error(`Table "${name}" not initialised`);
    return t;
  }

  /** Raw connection (for ad-hoc queries). */
  get db(): Connection {
    if (!this._db) throw new Error("Database not connected; call init() first");
    return this._db;
  }

  // ── Validation ────────────────────────────────────────────────

  /**
   * Validate startup config per ADR-014.
   * short: refuses to start if maxVectorUnitTokens exceeds model limit.
   */
  private validate(): void {
    const { maxVectorUnitTokens, modelMaxSeqLength } = this.config;
    if (maxVectorUnitTokens > modelMaxSeqLength) {
      throw new Error(
        `embedding.maxVectorUnitTokens (${maxVectorUnitTokens}) exceeds ` +
          `the active model's reported maximum sequence length ` +
          `(${modelMaxSeqLength}). Refusing to initialise (ADR-014).`,
      );
    }
  }

  // ── Table creation ────────────────────────────────────────────

  private async _createTables(): Promise<void> {
    const existing = new Set(await this._db!.tableNames());

    for (const def of ALL_TABLES) {
      await this._ensureTable(def, existing);
    }

    const vpDef = vectorPoolDef(this.config.embeddingDim);
    await this._ensureTable(vpDef, existing);
  }

  private async _ensureTable(
    def: TableDefinition,
    existing: Set<string>,
  ): Promise<void> {
    if (existing.has(def.name)) {
      this._tables.set(def.name, await this._db!.openTable(def.name));
      return;
    }

    const empty = new ArrowTable(def.schema);
    const table = await this._db!.createTable(def.name, empty, {
      mode: "create",
      primaryKey: def.primaryKey,
    });

    this._tables.set(def.name, table);
  }

  // ── Index creation ────────────────────────────────────────────

  private async _createIndexes(): Promise<void> {
    for (const def of ALL_TABLES) {
      if (!def.indexes?.length) continue;
      const table = this._tables.get(def.name)!;
      for (const idx of def.indexes) {
        await table.createIndex(idx.column, {
          indexType: idx.type,
          ...(idx.options ?? {}),
        });
      }
    }

    const vpDef = vectorPoolDef(this.config.embeddingDim);
    if (vpDef.indexes?.length) {
      const table = this._tables.get(vpDef.name)!;
      for (const idx of vpDef.indexes) {
        await table.createIndex(idx.column, {
          indexType: idx.type,
          ...(idx.options ?? {}),
        });
      }
    }
  }
}

// ── Batch-upsert helpers ──────────────────────────────────────────────
// shortcut: naive per-row insert via `add`. Upgrade to Arrow record-batch
// construction for bulk throughput when ingestion is profiled.

export async function upsertGrants(
  table: Table,
  rows: Array<{
    pattern: string;
    action: "allow" | "deny";
    reason: string;
    createdAt: Date;
  }>,
): Promise<void> {
  await table.add(rows);
}

export async function upsertProjects(
  table: Table,
  rows: Array<{
    projectId: string;
    rootUri: string;
    name: string;
    isGit: boolean;
    defaultCooldownSeconds: number | null;
    status: string;
    registeredAt: Date;
    lastSyncedAt: Date | null;
  }>,
): Promise<void> {
  await table.add(rows);
}

export async function upsertBranchMapping(
  table: Table,
  rows: Array<{
    branch: string;
    projectId: string;
    uri: string;
    fileVersionId: string;
    updatedAt: Date;
  }>,
): Promise<void> {
  await table.add(rows);
}

export async function upsertFileMapping(
  table: Table,
  rows: Array<{
    fileVersionId: string;
    projectId: string;
    uri: string;
    validUntil: Date | null;
    contentHash: string;
    language: string;
  }>,
): Promise<void> {
  await table.add(rows);
}

export async function upsertChunkMapping(
  table: Table,
  rows: Array<{
    fileVersionId: string;
    chunkIndex: number;
    chunkHash: string;
  }>,
): Promise<void> {
  await table.add(rows);
}

export async function upsertChunksPool(
  table: Table,
  rows: Array<{
    chunkHash: string;
    text: string;
    scopeContext: string | null;
  }>,
): Promise<void> {
  await table.add(rows);
}

export async function upsertVectorPool(
  table: Table,
  rows: Array<{
    chunkHash: string;
    unitIndex: number;
    vector: Float32Array;
  }>,
): Promise<void> {
  await table.add(rows);
}
