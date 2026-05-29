/**
 * @module bunql-core
 * @description BunQL facade implementation — holds internal state, delegates to operation modules.
 */

import { Database, type Statement as BunStatement, type SQLQueryBindings } from "bun:sqlite";
import type { TransactionContext } from "./transaction-manager.ts";
import { SqlQuery, sql as sqlTag } from "./query/sql-builder.ts";
import { MqlQuery } from "./query/mql-builder.ts";
import { parseMQL } from "./parser/mql-parser.ts";
import { astToMongo } from "./translator/to-mongodb.ts";
import type { MongoCommand } from "./translator/to-mongodb.ts";
import type { FTS5Helper } from "./fts5.ts";
import type {
  BunQLOptions, QueryResult, RunResult, Statement, BatchOperation,
  CheckpointMode, CheckpointResult, WalStatus, BackupResult, VacuumResult,
  TransactionMode, PragmaOptions, CacheStats, BunQLMetrics,
} from "./types/index.ts";
import { createStatementWrapper } from "./statement-wrapper.ts";
import { type BunQLState, createState } from "./bunql-state.ts";
import { startMaintenance } from "./bunql-maintenance.ts";
import { queryOps, runQueryOps } from "./bunql-query.ts";
import { writeOps } from "./bunql-tx.ts";
import { maintenanceOps } from "./bunql-maintenance.ts";
import { closeBunQL } from "./bunql-close.ts";

function executeBatchOperations(
  operations: BatchOperation[],
  getStmt: (sql: string) => BunStatement,
  hooks?: { beforeWrite?: (sql: string, params: unknown[]) => void; afterWrite?: (sql: string, params: unknown[], ms: number) => void },
): RunResult[] {
  const results: RunResult[] = [];
  for (const op of operations) {
    hooks?.beforeWrite?.(op.sql, op.params ?? []);
    const start = performance.now();
    const stmt = getStmt(op.sql);
    const raw = stmt.run(...(op.params ?? []));
    results.push({
      changes: raw.changes,
      lastInsertRowid: raw.lastInsertRowid,
      durationMs: performance.now() - start,
    });
    hooks?.afterWrite?.(op.sql, op.params ?? [], performance.now() - start);
  }
  return results;
}

export class BunQL {
  readonly #s: BunQLState;

  constructor(path: string, options?: BunQLOptions) {
    this.#s = createState(path, options);
    if (this.#s.maintenance) startMaintenance(this.#s);
    this.#s.log("info", `Database opened: ${path} (WAL: ${this.#s.config.wal})`);
  }

  get closed(): boolean { return this.#s.closed; }
  get queueSize(): number { return this.#s.writeQueue.size; }
  get isProcessing(): boolean { return this.#s.writeQueue.isProcessing; }
  get name(): string { this.#s.ensureOpen(); return this.#s.name; }
  get memory(): boolean { this.#s.ensureOpen(); return this.#s.memory; }
  get readonly(): boolean { return this.#s.config.readonly; }
  get inTransaction(): boolean { return this.#s.txManager.depth > 0; }
  get raw(): Database { this.#s.ensureOpen(); return this.#s.db; }
  get fts(): FTS5Helper { this.#s.ensureOpen(); return this.#s.fts; }
  get metrics(): BunQLMetrics { return this.#s.metrics(); }
  get cacheStats(): CacheStats { return this.#s.cacheStats(); }

  pragma(source: string, options?: PragmaOptions): unknown {
    this.#s.ensureOpen();
    const sql = source.startsWith("PRAGMA") ? source : `PRAGMA ${source}`;
    this.#s.verboseLog(sql);
    const rows = this.#s.db.prepare(sql).all();
    if (options?.simple) {
      if (rows.length === 0) return undefined;
      const first = rows[0] as Record<string, unknown>;
      const key = Object.keys(first)[0];
      return key !== undefined ? first[key] : undefined;
    }
    return rows;
  }

  serialize(): Uint8Array {
    this.#s.ensureOpen();
    return (this.#s.db as unknown as { serialize(): Uint8Array }).serialize();
  }

  static deserialize(contents: Uint8Array, options?: BunQLOptions): BunQL {
    const db = (Database as unknown as { deserialize(buf: Uint8Array): Database }).deserialize(contents);
    return new BunQL(":memory:", { ...options, dbInstance: db });
  }

  query<T = Record<string, unknown>>(sql: string, params?: SQLQueryBindings[]): QueryResult<T> {
    return queryOps.query<T>(this.#s, sql, params);
  }

  querySync<T = Record<string, unknown>>(sql: string, params?: SQLQueryBindings[]): QueryResult<T> {
    return queryOps.querySync<T>(this.#s, sql, params);
  }

  run(sql: string, params?: SQLQueryBindings[]): RunResult {
    return runQueryOps.run(this.#s, sql, params);
  }

  async transaction<T>(callback: (tx: TransactionContext) => Promise<T>, mode?: TransactionMode): Promise<T> {
    return writeOps.transaction(this.#s, callback, mode);
  }

  prepare<T = unknown, P extends SQLQueryBindings[] = SQLQueryBindings[]>(sql: string): Statement<T, P> {
    this.#s.ensureOpen();
    return createStatementWrapper<T, P>(sql, this.#s.statementCache, this.#s.config.safeIntegers, this.#s.metricsEnabled, this.#s.verboseLog.bind(this.#s));
  }

  async batch(operations: BatchOperation[]): Promise<RunResult[]> {
    return writeOps.batch(this.#s, operations, executeBatchOperations);
  }

  async exec(sql: string): Promise<void> {
    return writeOps.exec(this.#s, sql);
  }

  async checkpoint(mode: CheckpointMode = "PASSIVE"): Promise<CheckpointResult> {
    return maintenanceOps.checkpoint(this.#s, mode);
  }

  async walStatus(): Promise<WalStatus> {
    return maintenanceOps.walStatus(this.#s);
  }

  async backup(path: string): Promise<BackupResult> {
    return maintenanceOps.backup(this.#s, path);
  }

  async vacuum(options?: { incremental?: boolean; pagesPerStep?: number }): Promise<VacuumResult> {
    return maintenanceOps.vacuum(this.#s, options);
  }

  async close(): Promise<void> {
    return closeBunQL(this.#s);
  }

  sql(strings: TemplateStringsArray, ...values: unknown[]): SqlQuery {
    const q = sqlTag(strings, ...values);
    return new SqlQuery(q.sql, q.params, {
      executeSQL: (sql, params) => {
        const result = this.query(sql, params as SQLQueryBindings[]);
        return { columns: result.columns, rows: result.rows as Record<string, unknown>[], duration: result.durationMs };
      },
      executeRun: (sql, params) => {
        const result = this.run(sql, params as SQLQueryBindings[]);
        return { changes: result.changes, lastInsertRowid: result.lastInsertRowid ?? 0 };
      },
      isAsync: false,
    });
  }

  mql(collection: string): MqlQuery {
    return new MqlQuery(collection, {
      executeMQL: (col, method, args) => {
        this.#parseMQL(col, method, args);
        throw new Error(
          "MongoDB queries require MongoDriver from @nds-stack/bunql/driver. " +
          "BunQL class currently supports SQLite only.",
        );
      },
      executeMQLRun: (col, method, args) => {
        this.#parseMQL(col, method, args);
        throw new Error(
          "MongoDB writes require MongoDriver from @nds-stack/bunql/driver. " +
          "BunQL class currently supports SQLite only.",
        );
      },
    });
  }

  #parseMQL(collection: string, method: string, args: unknown[]): MongoCommand {
    const node = parseMQL(collection, method, args);
    return astToMongo(node);
  }
}
