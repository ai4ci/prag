// @prag/core — LanceDB 7-table schema initialisation and helpers
//
// Connects to a local LanceDB database, creates the 7 CAS tables on first run,
// installs indexes (FTS on chunks_pool.text, IVF_PQ on vector_pool.vector),
// and provides transactional batch-upsert helpers.

import lancedb, {
  Index,
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
  Type,
  type DataType,
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
  /**
   * Uniqueness key, per storage-schema.md. LanceDB 0.41 has no primary-key
   * option, so this is documentation of intent: the same keys are what the
   * `mergeInsert` calls in the upsert* helpers enforce uniqueness with, and what
   * `_ensureTable` compares against on an existing table.
   */
  primaryKey: string | string[];
  indexes?: Array<{
    column: string;
    /** Index config factory: Index.fts() for FTS, Index.ivfPq() for vector. */
    build: () => Index;
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
    // Composite in storage-schema.md:117-119 -- (branch, projectId, uri): one row
    // per file per branch, so the same uri may be held by several branches.
    primaryKey: ["branch", "projectId", "uri"],
  },
  {
    name: "file_mapping",
    schema: fileMappingSchema(),
    primaryKey: "fileVersionId",
  },
  {
    name: "chunk_mapping",
    schema: chunkMappingSchema(),
    // storage-schema.md gives chunk_mapping no PK of its own; the pair is what
    // makes a chunk's position within a file version unique.
    primaryKey: ["fileVersionId", "chunkIndex"],
  },
  {
    name: "chunks_pool",
    schema: chunksPoolSchema(),
    primaryKey: "chunkHash",
    indexes: [{ column: FTS_COLUMN, build: () => Index.fts() }],
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
    // Composite (chunkHash, unitIndex): a chunk that overflows one vector unit
    // stores units 0..N under the same chunkHash, so chunkHash alone is not unique.
    primaryKey: ["chunkHash", "unitIndex"],
    indexes: [
      {
        column: VECTOR_COLUMN,
        build: () => Index.ivfPq(),
      },
    ],
  };
}

// ── Schema verification ───────────────────────────────────────────────

/**
 * A type identity that survives the Rust/JS boundary. `DataType.toString` is a
 * method on the prototype, so it has to be derived from `typeId` plus whatever
 * parameters the type carries — and those parameters are exactly what skew
 * between builds (the vector dimension, an int width, a date unit).
 */
function typeKey(type: DataType): string {
  const t = type as unknown as { typeId: number; listSize?: number; unit?: number; bitWidth?: number };
  const base = Type[t.typeId] ?? `type#${t.typeId}`;
  if (base === "FixedSizeList") return `${base}<${t.listSize}>`;
  if (base === "Date" || base === "Interval") return `${base}(${t.unit})`;
  if (base === "Int" || base === "Float" || base === "Decimal") return `${base}(${t.bitWidth})`;
  return base;
}

/**
 * Columns this build needs that the stored table does not have, in the shape
 * `column "x" is Utf8?, want Utf8` / `missing column "x" (want …)` /
 * `unexpected column "y"`.
 *
 * This check exists because LanceDB does not reject a mismatch: `add()` on a
 * `FixedSizeList(4)` column silently *truncates* an 8-element vector to 4 (and
 * only rejects a short one, as a NaN error), so an index written by an older
 * build would keep accepting writes with the wrong embeddings rather than
 * failing. Search over those vectors returns confidently ranked nonsense.
 */
export function schemaDiff(want: Schema, got: Schema): string[] {
  const keys = (s: Schema): Map<string, string> =>
    new Map(s.fields.map((f) => [f.name, `${typeKey(f.type)}${f.nullable ? "?" : ""}`]));
  const w = keys(want);
  const g = keys(got);
  const out: string[] = [];
  for (const [name, type] of w) {
    const have = g.get(name);
    if (have === undefined) out.push(`missing column "${name}" (want ${type})`);
    else if (have !== type) out.push(`column "${name}" is ${have}, want ${type}`);
  }
  for (const name of g.keys()) {
    if (!w.has(name)) out.push(`unexpected column "${name}"`);
  }
  return out;
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
      // shortcut: 512 is the bge-small figure, and the ADR-014 gate cannot fire
      // without a real value. Every production caller passes the provider's own
      // maxSeqLength (packages/daemon/src/main.ts); a caller that omits this gets
      // the pre-ADR-014 behaviour. Upgrade by making it required.
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
      const table = await this._db!.openTable(def.name);
      const diff = schemaDiff(def.schema, await table.schema());
      if (diff.length > 0) {
        throw new Error(
          `Table "${def.name}" was written by an incompatible prag version: ` +
            `${diff.join("; ")}. This build expects\n  ` +
            def.schema.fields.map((f) => `${f.name}: ${typeKey(f.type)}`).join(", ") +
            `\nRefusing to read or write it -- repair requires a schema migration or a fresh ` +
            `index (remove ${this.config.dbPath} and re-index).`,
        );
      }
      this._tables.set(def.name, table);
      return;
    }

    // def.primaryKey is *not* passed to createTable: LanceDB 0.41 has no
    // primary-key option, so it was silently ignored. Uniqueness is enforced at
    // write time by the mergeInsert keys in the upsert* helpers instead.
    const empty = new ArrowTable(def.schema);
    const table = await this._db!.createTable(def.name, empty, {
      mode: "create",
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
          config: idx.build(),
        });
      }
    }

    const vpDef = vectorPoolDef(this.config.embeddingDim);
    if (vpDef.indexes?.length) {
      const table = this._tables.get(vpDef.name)!;
      for (const idx of vpDef.indexes) {
        await table.createIndex(idx.column, {
          config: idx.build(),
        });
      }
    }
  }
}

// ── Batch-upsert helpers ──────────────────────────────────────────────
//
// Every helper is a real merge-insert keyed on the table's primary key, so
// re-feeding the same row is a no-op rather than a duplicate. `add()` was
// append-only, which meant a re-index of an unchanged file grew file_mapping,
// chunk_mapping and vector_pool on every pass.
// shortcut: per-key merge rather than one Arrow batch; upgrade to record-batch
// construction for bulk throughput when ingestion is profiled.

async function merge(
  table: Table,
  on: string | string[],
  rows: Record<string, unknown>[],
  updateOnMatch = true,
): Promise<void> {
  if (rows.length === 0) return;
  const builder = table.mergeInsert(on).whenNotMatchedInsertAll();
  // chunks_pool rows are identical by construction (keyed by content hash), so
  // the update is a no-op there; mapping tables do carry changed values.
  await (updateOnMatch ? builder.whenMatchedUpdateAll() : builder).execute(
    rows as never,
  );
}

export async function upsertGrants(
  table: Table,
  rows: Array<{
    pattern: string;
    action: "allow" | "deny";
    reason: string;
    createdAt: Date;
  }>,
): Promise<void> {
  await merge(table, "pattern", rows);
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
  // status/lastSyncedAt are daemon-owned; a re-watch must not resurrect
  // registeredAt or clobber a paused state.
  await merge(table, "projectId", rows);
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
  await merge(table, ["projectId", "branch", "uri"], rows);
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
  await merge(table, "fileVersionId", rows);
}

export async function upsertChunkMapping(
  table: Table,
  rows: Array<{
    fileVersionId: string;
    chunkIndex: number;
    chunkHash: string;
  }>,
): Promise<void> {
  await merge(table, ["fileVersionId", "chunkIndex"], rows);
}

export async function upsertChunksPool(
  table: Table,
  rows: Array<{
    chunkHash: string;
    text: string;
    scopeContext: string | null;
  }>,
): Promise<void> {
  await merge(table, "chunkHash", rows, false);
}

export async function upsertVectorPool(
  table: Table,
  rows: Array<{
    chunkHash: string;
    unitIndex: number;
    vector: Float32Array;
  }>,
): Promise<void> {
  await merge(table, ["chunkHash", "unitIndex"], rows);
}
