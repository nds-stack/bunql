/**
 * @module bunql
 * @description BunQL facade — main entry point, thin wrapper over bun:sqlite.
 */
import { Database, type Statement as BunStatement, type SQLQueryBindings } from "bun:sqlite";
import { WriteQueue } from "./write-queue.ts";
import { RetryPolicy, DEFAULT_RETRY_CONFIG } from "./retry-policy.ts";
import { TransactionManager, type TransactionContext } from "./transaction-manager.ts";
import { StatementCache } from "./statement-cache.ts";
import { ReaderPool } from "./reader-pool.ts";
import { FTS5Helper } from "./fts5.ts";
import { ConnectionError } from "./errors/connection-error.ts";
import { QueueError } from "./errors/queue-error.ts";
import type {
  BunQLOptions,
  BunQLConfig,
  BunQLHooks,
  QueryResult,
  RunResult,
  Statement,
  ColumnInfo,
  BatchOperation,
  Logger,
  EventHandlers,
  RetryConfig,
  BunQLMetrics,
  CacheStats,
  CheckpointMode,
  CheckpointResult,
  WalStatus,
  BackupResult,
  VacuumResult,
  MaintenanceConfig,
  TransactionMode,
  PragmaOptions,
} from "./types/index.ts";

function executeBatchOperations(
  operations: BatchOperation[],
  getStmt: (sql: string) => BunStatement,
  hooks?: BunQLHooks,
): RunResult[] {
  const results: RunResult[] = [];
  for (const op of operations) {
    hooks?.beforeWrite?.(op.sql, op.params ?? []);
    const start = performance.now();
    const stmt = getStmt(op.sql);
    const raw = stmt.run(...(op.params ?? []));
    const result: RunResult = {
      changes: raw.changes,
      lastInsertRowid: raw.lastInsertRowid,
      durationMs: performance.now() - start,
    };
    results.push(result);
    hooks?.afterWrite?.(op.sql, op.params ?? [], performance.now() - start);
  }
  return results;
}

interface StmtInternals {
  raw: boolean;
  pluck: boolean;
  safeInts: boolean;
  bound: SQLQueryBindings[] | null;
}

export class BunQL {
  #db: Database;
  #config: BunQLConfig;
  #writeQueue: WriteQueue;
  #retryPolicy: RetryPolicy;
  #transactionManager: TransactionManager;
  #statementCache: StatementCache;
  #readerPool: ReaderPool | null = null;
  #fts5: FTS5Helper;
  #closed = false;
  #logger?: Logger;
  #onError?: (error: Error) => void;
  #maintenanceTimer: Timer | null = null;
  #metrics: BunQLMetrics = {
    writes: { total: 0, failed: 0, retried: 0 },
    reads: { total: 0 },
    queue: { currentSize: 0, peakSize: 0, totalEnqueued: 0 },
    transactions: { committed: 0, rolledBack: 0 },
  };
  #metricsEnabled = false;
  #queryTimeoutMs = 0;
  #extractColumns = false;
  #pageSize = 4096;
  #verbose: ((sql: string) => void) | null = null;

  constructor(path: string, options?: BunQLOptions) {
    const config = this.#resolveConfig(options);
    this.#config = config;
    this.#logger = config.logger;

    this.#metricsEnabled = config.metricsEnabled;
    this.#queryTimeoutMs = config.queryTimeoutMs;
    this.#extractColumns = config.extractColumns;

    if (typeof config.verbose === "function") {
      this.#verbose = config.verbose;
    } else if (config.verbose === true) {
      this.#verbose = (sql: string) => this.#log("debug", sql);
    }

    if (config.readerPoolSize > 0 && !config.wal) {
      throw new ConnectionError(
        "Reader pool requires WAL mode. Set `wal: true` or remove `readerPool` option.",
      );
    }

    const dbOptions: { readonly?: boolean; safeIntegers?: boolean; create?: boolean } = {};
    if (config.readonly) dbOptions.readonly = true;
    if (config.safeIntegers) dbOptions.safeIntegers = true;
    dbOptions.create = true;

    try {
      this.#db = new Database(path, dbOptions);
    } catch (error) {
      throw new ConnectionError(
        `Failed to open database: ${path}`,
        { cause: error instanceof Error ? error : undefined },
      );
    }

    if (config.wal && !config.readonly) {
      this.#db.run("PRAGMA journal_mode=WAL");
    }

    this.#db.run(`PRAGMA synchronous=${config.synchronous}`);
    this.#db.run(`PRAGMA cache_size=${config.cacheSize}`);

    if (config.foreignKeys) {
      this.#db.run("PRAGMA foreign_keys=ON");
    }

    if (config.busyTimeout > 0) {
      this.#db.run(`PRAGMA busy_timeout=${config.busyTimeout}`);
    }

    if (config.autoVacuum !== "NONE") {
      this.#db.run(`PRAGMA auto_vacuum=${config.autoVacuum}`);
    }

    this.#pageSize = (this.#db
      .prepare("PRAGMA page_size")
      .get() as Record<string, number>)?.["page_size"] ?? 4096;

    this.#writeQueue = new WriteQueue();
    this.#retryPolicy = new RetryPolicy(config.retry);
    this.#statementCache = new StatementCache(this.#db);
    this.#transactionManager = new TransactionManager(
      this.#db,
      this.#writeQueue,
      config.hooks,
      this.#logger,
    );
    this.#fts5 = new FTS5Helper(this.#db);

    if (config.readerPoolSize > 0) {
      this.#readerPool = new ReaderPool(path, config.readerPoolSize);
    }

    this.#setupEventHandlers(config.events);
    this.#startMaintenance(config.maintenance);
    this.#log("info", `Database opened: ${path} (WAL: ${config.wal})`);
  }

  get closed(): boolean {
    return this.#closed;
  }

  get queueSize(): number {
    return this.#writeQueue.size;
  }

  get isProcessing(): boolean {
    return this.#writeQueue.isProcessing;
  }

  get name(): string {
    this.#ensureOpen();
    return (this.#db as unknown as { filename?: string }).filename
      ?? (this.#db as unknown as { name?: string }).name
      ?? "";
  }

  get memory(): boolean {
    this.#ensureOpen();
    return (this.#db as unknown as { memory?: boolean }).memory ?? false;
  }

  get readonly(): boolean {
    return this.#config.readonly;
  }

  get inTransaction(): boolean {
    return this.#transactionManager.depth > 0;
  }

  get raw(): Database {
    this.#ensureOpen();
    return this.#db;
  }

  get fts(): FTS5Helper {
    this.#ensureOpen();
    return this.#fts5;
  }

  get metrics(): BunQLMetrics {
    const tx = this.#transactionManager.metrics;
    return {
      writes: { ...this.#metrics.writes },
      reads: { ...this.#metrics.reads },
      queue: {
        currentSize: this.#writeQueue.size,
        peakSize: this.#writeQueue.peakSize,
        totalEnqueued: this.#writeQueue.totalEnqueued,
      },
      transactions: { committed: tx.committed, rolledBack: tx.rolledBack },
    };
  }

  get cacheStats(): CacheStats {
    let hits = this.#statementCache.hits;
    let misses = this.#statementCache.misses;

    if (this.#readerPool) {
      const poolStats = this.#readerPool.cacheStats();
      hits += poolStats.hits;
      misses += poolStats.misses;
    }

    const total = hits + misses;
    return {
      size: this.#statementCache.size + (this.#readerPool?.cacheStats().size ?? 0),
      hits,
      misses,
      hitRate: total > 0 ? hits / total : 0,
    };
  }

  /**
   * Convenience method for PRAGMA queries. Returns structured rows, or a scalar value
   * when `{ simple: true }` (first column of first row).
   */
  pragma(source: string, options?: PragmaOptions): unknown {
    this.#ensureOpen();
    const sql = source.startsWith("PRAGMA") ? source : `PRAGMA ${source}`;
    this.#verboseLog(sql);
    const rows = this.#db.prepare(sql).all();
    if (options?.simple) {
      if (rows.length === 0) return undefined;
      const first = rows[0] as Record<string, unknown>;
      const key = Object.keys(first)[0];
      return key !== undefined ? first[key] : undefined;
    }
    return rows;
  }

  /**
   * Serialize the entire database to a Uint8Array. Can be reloaded later
   * via BunQL.deserialize() or Database.deserialize().
   */
  serialize(): Uint8Array {
    this.#ensureOpen();
    return (this.#db as unknown as { serialize(): Uint8Array }).serialize();
  }

  /**
   * Create a new BunQL instance from a serialized database buffer.
   */
  static deserialize(contents: Uint8Array, options?: BunQLOptions): BunQL {
    const db = (Database as unknown as { deserialize(buf: Uint8Array): Database }).deserialize(contents);
    const instance = Object.create(BunQL.prototype) as BunQL;
    (instance as unknown as { initFromDb: (db: Database, opts?: BunQLOptions) => void }).initFromDb(db, options);
    return instance;
  }

  private initFromDb(db: Database, options?: BunQLOptions): void {
    const config = this.#resolveConfig(options);
    this.#config = config;
    this.#logger = config.logger;
    this.#metricsEnabled = config.metricsEnabled;
    this.#queryTimeoutMs = config.queryTimeoutMs;
    this.#extractColumns = config.extractColumns;

    if (typeof config.verbose === "function") {
      this.#verbose = config.verbose;
    } else if (config.verbose === true) {
      this.#verbose = (sql: string) => this.#log("debug", sql);
    }

    this.#db = db;
    this.#pageSize = 4096;
    this.#writeQueue = new WriteQueue();
    this.#retryPolicy = new RetryPolicy(config.retry);
    this.#statementCache = new StatementCache(this.#db);
    this.#transactionManager = new TransactionManager(
      this.#db,
      this.#writeQueue,
      config.hooks,
      this.#logger,
    );
    this.#fts5 = new FTS5Helper(this.#db);
    this.#setupEventHandlers(config.events);
  }

  query<T = Record<string, unknown>>(sql: string, params?: SQLQueryBindings[]): QueryResult<T> {
    this.#ensureOpen();
    this.#verboseLog(sql);

    if (this.#metricsEnabled) this.#metrics.reads.total++;
    const start = this.#metricsEnabled ? performance.now() : 0;
    let timer: Timer | undefined;
    if (this.#queryTimeoutMs > 0) {
      timer = setTimeout(() => (this.#db as unknown as { interrupt(): void }).interrupt(), this.#queryTimeoutMs);
    }

    let rows: T[];
    try {
      if (this.#readerPool) {
        const entry = this.#readerPool.next();
        const stmt = entry.cache.get(sql);
        rows = stmt.all(...(params ?? [])) as T[];
      } else {
        const stmt = this.#statementCache.get(sql);
        rows = stmt.all(...(params ?? [])) as T[];
      }
    } finally {
      if (timer) clearTimeout(timer);
    }

    const durationMs = this.#metricsEnabled ? performance.now() - start : 0;

    if (this.#config.slowQueryThreshold > 0 && durationMs > this.#config.slowQueryThreshold) {
      this.#config.events?.onSlowQuery?.(sql, durationMs);
    }

    const columns = this.#extractColumns && rows.length > 0
      ? Object.keys(rows[0] as Record<string, unknown>)
      : [];
    return { rows, columns, durationMs };
  }

  querySync<T = Record<string, unknown>>(sql: string, params?: SQLQueryBindings[]): QueryResult<T> {
    this.#ensureOpen();
    this.#verboseLog(sql);
    const start = this.#metricsEnabled ? performance.now() : 0;
    const stmt = this.#statementCache.get(sql);
    const rows = stmt.all(...(params ?? [])) as T[];
    const durationMs = this.#metricsEnabled ? performance.now() - start : 0;
    const columns = this.#extractColumns && rows.length > 0
      ? Object.keys(rows[0] as Record<string, unknown>)
      : [];
    return { rows, columns, durationMs };
  }

  run(sql: string, params?: SQLQueryBindings[]): RunResult {
    this.#ensureOpen();
    this.#verboseLog(sql);
    if (this.#metricsEnabled) this.#metrics.writes.total++;
    const start = this.#metricsEnabled ? performance.now() : 0;
    const stmt = this.#statementCache.get(sql);
    const raw = stmt.run(...(params ?? []));
    const result: RunResult = {
      changes: raw.changes,
      lastInsertRowid: raw.lastInsertRowid,
      durationMs: this.#metricsEnabled ? performance.now() - start : 0,
    };
    if (this.#config.slowQueryThreshold > 0 && result.durationMs > this.#config.slowQueryThreshold) {
      this.#config.events?.onSlowQuery?.(sql, result.durationMs);
    }
    return result;
  }

  async transaction<T>(
    callback: (tx: TransactionContext) => Promise<T>,
    mode?: TransactionMode,
  ): Promise<T> {
    this.#ensureOpen();
    const txMode = mode ?? this.#config.transactionMode;
    const result = await this.#transactionManager.transaction(callback, txMode);
    return result;
  }

  prepare<T = unknown, P extends SQLQueryBindings[] = SQLQueryBindings[]>(
    sql: string,
  ): Statement<T, P> {
    this.#ensureOpen();
    return this.#createStatementWrapper<T, P>(sql, this.#statementCache);
  }

  async batch(operations: BatchOperation[]): Promise<RunResult[]> {
    this.#ensureOpen();

    this.#metrics.writes.total++;
    return this.#writeQueue.enqueue(async () => {
      try {
        this.#db.run("BEGIN IMMEDIATE");
        const results = executeBatchOperations(operations, (sql) => this.#statementCache.get(sql), this.#config.hooks);
        this.#db.run("COMMIT");
        return results;
      } catch (error) {
        this.#metrics.writes.failed++;
        this.#db.run("ROLLBACK");
        const err = error instanceof Error ? error : new Error(String(error));
        this.#onError?.(err);
        throw new QueueError(
          "Batch operation failed, transaction rolled back",
          { cause: err },
        );
      }
    });
  }

  async exec(sql: string): Promise<void> {
    this.#ensureOpen();

    this.#metrics.writes.total++;
    await this.#writeQueue.enqueue(async () => {
      try {
        this.#db.exec(sql);
      } catch (error) {
        this.#metrics.writes.failed++;
        this.#onError?.(error instanceof Error ? error : new Error(String(error)));
        throw new QueueError("Exec operation failed", {
          cause: error instanceof Error ? error : undefined,
        });
      }
    });
  }

  async checkpoint(mode: CheckpointMode = "PASSIVE"): Promise<CheckpointResult> {
    this.#ensureOpen();
    return this.#writeQueue.enqueue(async () => {
      return this.#checkpointDirect(mode);
    });
  }

  async walStatus(): Promise<WalStatus> {
    this.#ensureOpen();
    return this.#writeQueue.enqueue(async () => {
      return this.#walStatusDirect();
    });
  }

  async backup(path: string): Promise<BackupResult> {
    this.#ensureOpen();
    this.#validateBackupPath(path);
    const start = performance.now();

    await this.#writeQueue.enqueue(async () => {
      this.#db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
    });

    const file = Bun.file(path);
    const size = file.size ?? 0;
    return { size, durationMs: performance.now() - start };
  }

  async vacuum(options?: { incremental?: boolean; pagesPerStep?: number }): Promise<VacuumResult> {
    this.#ensureOpen();
    const start = performance.now();

    const startCount = (this.#db
      .prepare("PRAGMA freelist_count")
      .get() as Record<string, number>)?.["freelist_count"] ?? 0;

    await this.#writeQueue.enqueue(async () => {
      if (options?.incremental) {
        const pages = options.pagesPerStep ?? 100;
        this.#db.exec(`PRAGMA incremental_vacuum(${pages})`);
      } else {
        this.#db.exec("VACUUM");
      }
    });

    const endCount = (this.#db
      .prepare("PRAGMA freelist_count")
      .get() as Record<string, number>)?.["freelist_count"] ?? 0;

    return {
      pagesReclaimed: Math.max(0, startCount - endCount),
      durationMs: performance.now() - start,
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    if (this.#maintenanceTimer) {
      clearInterval(this.#maintenanceTimer);
      this.#maintenanceTimer = null;
    }

    this.#writeQueue.close();
    this.#writeQueue.clearPending("Database is closing");

    try {
      await this.#writeQueue.drain();
    } catch {
      // drain completed or timed out
    }

    this.#statementCache.clear();

    this.#readerPool?.close();

    try {
      this.#db.close();
      this.#log("info", "Database closed");
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.#onError?.(err);
      throw new ConnectionError(
        "Failed to close database",
        { cause: err },
      );
    }
  }

  #createStatementWrapper<T, P extends SQLQueryBindings[]>(
    sql: string,
    cache: StatementCache,
  ): Statement<T, P> {
    const native: BunStatement = cache.get(sql);
    const internals: StmtInternals = {
      raw: false,
      pluck: false,
      safeInts: this.#config.safeIntegers,
      bound: null,
    };

    const applyParams = (params?: SQLQueryBindings[]): unknown[] => {
      if (!params || params.length === 0) {
        return internals.bound ?? [];
      }
      return params;
    };

    const transformRow = <R>(row: unknown): R => {
      if (internals.pluck) {
        if (Array.isArray(row)) return (row as unknown[])[0] as R;
        return (Object.values(row as Record<string, unknown>))[0] as R;
      }
      return row as R;
    };

    const getReader = (): boolean => {
      const trimmed = sql.trimStart().toUpperCase();
      return trimmed.startsWith("SELECT") || trimmed.startsWith("WITH") || trimmed.startsWith("PRAGMA");
    };

    const stmt: Statement<T, P> = {
      all: (...params: P): T[] => {
        this.#verboseLog(sql);
        const effective = applyParams(params as unknown as SQLQueryBindings[]);
        if (internals.raw) {
          const rows = native.values(...effective) as unknown[][];
          if (internals.pluck) return rows.map((r) => (r.length > 0 ? r[0] : undefined)) as T[];
          return rows as T[];
        }
        const rows = native.all(...effective) as unknown[];
        return rows.map((r) => transformRow<T>(r));
      },

      get: (...params: P): T | undefined => {
        this.#verboseLog(sql);
        const effective = applyParams(params as unknown as SQLQueryBindings[]);
        if (internals.raw) {
          const rows = native.values(...effective) as unknown[][];
          if (rows.length === 0) return undefined;
          const first = rows[0] as unknown[];
          if (internals.pluck) return (first.length > 0 ? first[0] : undefined) as T;
          return first as T;
        }
        const row = native.get(...effective) as unknown;
        if (row === undefined || row === null) return undefined;
        return transformRow<T>(row);
      },

      run: (...params: P): RunResult => {
        this.#verboseLog(sql);
        const effective = applyParams(params as unknown as SQLQueryBindings[]);
        const start = this.#metricsEnabled ? performance.now() : 0;
        const result = native.run(...effective);
        return {
          changes: result.changes,
          lastInsertRowid: result.lastInsertRowid,
          durationMs: this.#metricsEnabled ? performance.now() - start : 0,
        };
      },

      values: (...params: P): unknown[][] => {
        this.#verboseLog(sql);
        const effective = applyParams(params as unknown as SQLQueryBindings[]);
        return native.values(...effective);
      },

      iterate: (...params: P): IterableIterator<T> => {
        this.#verboseLog(sql);
        const effective = applyParams(params as unknown as SQLQueryBindings[]);
        const useValues = internals.raw;
        const nativeIter = (native as unknown as { iterate?(...p: unknown[]): IterableIterator<unknown> }).iterate;
        const iter = (useValues || !nativeIter)
          ? native.values(...effective)[Symbol.iterator]()
          : nativeIter.call(native, ...effective);
        return {
          [Symbol.iterator](): IterableIterator<T> {
            return this;
          },
          next(): IteratorResult<T> {
            const { value, done } = iter.next();
            if (done) return { value: undefined as unknown as T, done: true };
            if (internals.raw) {
              if (internals.pluck) return { value: (Array.isArray(value) && (value as unknown[]).length > 0 ? (value as unknown[])[0] : undefined) as T, done: false };
              return { value: value as T, done: false };
            }
            return { value: transformRow<T>(value), done: false };
          },
        } as IterableIterator<T>;
      },

      finalize: (): void => {
        cache.remove(sql);
      },

      raw: (toggle?: boolean): Statement<unknown[], P> => {
        internals.raw = toggle !== false;
        if (internals.raw) internals.pluck = false;
        return stmt as unknown as Statement<unknown[], P>;
      },

      pluck: (toggle?: boolean): Statement<unknown, P> => {
        internals.pluck = toggle !== false;
        if (internals.pluck) internals.raw = false;
        return stmt as unknown as Statement<unknown, P>;
      },

      columns: (): ColumnInfo[] => {
        return native.columnNames.map((name) => ({
          name,
          column: null,
          table: null,
          database: null,
          type: null,
        }));
      },

      bind: (...params: P): Statement<T, P> => {
        internals.bound = params as unknown as SQLQueryBindings[];
        return stmt;
      },

      safeIntegers: (toggle?: boolean): Statement<T, P> => {
        internals.safeInts = toggle !== false;
        return stmt;
      },

      as: <U>(Class: new (...args: unknown[]) => U): Statement<U, P> => {
        const base = stmt as unknown as Statement<unknown, P>;
        const mapRow = (r: unknown): U => Object.assign(Object.create(Class.prototype), r) as U;
        const wrapped: Statement<U, P> = {
          all: (...params: P): U[] => {
            const rows = base.all(...params);
            return rows.map((r) => mapRow(r));
          },
          get: (...params: P): U | undefined => {
            const row = base.get(...params);
            if (row === undefined || row === null) return undefined;
            return mapRow(row);
          },
          run: base.run,
          values: base.values,
          iterate(...params: P): IterableIterator<U> {
            const iter = base.iterate(...params);
            return {
              [Symbol.iterator]() { return this; },
              next(): IteratorResult<U> {
                const { value, done } = iter.next();
                if (done) return { value: undefined as unknown as U, done: true };
                return { value: mapRow(value), done: false };
              },
            };
          },
          finalize: base.finalize,
          raw: ((toggle?: boolean) => base.raw(toggle)) as unknown as Statement<U, P>["raw"],
          pluck: ((toggle?: boolean) => base.pluck(toggle)) as unknown as Statement<U, P>["pluck"],
          columns: base.columns,
          bind: ((...params: P) => base.bind(...params)) as unknown as Statement<U, P>["bind"],
          safeIntegers: ((toggle?: boolean) => base.safeIntegers(toggle)) as unknown as Statement<U, P>["safeIntegers"],
          as: (<V>(C: new (...args: unknown[]) => V) => base.as(C)) as unknown as Statement<U, P>["as"],
          get source() { return base.source; },
          get reader() { return base.reader; },
        };
        return wrapped;
      },

      get source(): string {
        return native.toString();
      },

      get reader(): boolean {
        return getReader();
      },
    };

    return stmt;
  }

  #validateBackupPath(path: string): void {
    if (!path || path.length === 0) {
      throw new Error("Backup path must not be empty.");
    }
    if (path.length > 512) {
      throw new Error(`Backup path too long (${path.length} chars, max 512).`);
    }
    if (path.includes("..")) {
      throw new Error(
        `Invalid backup path: ${path}. Path traversal (..) is not allowed.`,
      );
    }
    if (path.includes("\0")) {
      throw new Error(
        `Invalid backup path: ${path}. Null byte not allowed.`,
      );
    }
    if (path.includes("\\")) {
      throw new Error(
        `Invalid backup path: ${path}. Backslash not allowed — use forward slash.`,
      );
    }
    if (!/^[\w./_-]+$/.test(path) && !/^[a-zA-Z]:/.test(path)) {
      throw new Error(
        `Invalid backup path: ${path}. Only alphanumeric, /, ., _, - allowed.`,
      );
    }
  }

  #getPageSize(): number {
    return this.#pageSize;
  }

  #checkpointDirect(mode: CheckpointMode = "PASSIVE"): CheckpointResult {
    const modeMap: Record<CheckpointMode, number> = {
      PASSIVE: 0, FULL: 1, RESTART: 2, TRUNCATE: 3,
    };
    const row = this.#db
      .prepare(`PRAGMA wal_checkpoint(${modeMap[mode]})`)
      .get() as Record<string, number>;
    const pageSize = this.#getPageSize();
    return {
      pagesCheckpointed: row?.[2] ?? 0,
      walSizeBytes: (row?.[1] ?? 0) * pageSize,
    };
  }

  #walStatusDirect(): WalStatus {
    const pageSize = this.#getPageSize();
    const pageCount = (this.#db
      .prepare("PRAGMA page_count")
      .get() as Record<string, number>)?.["page_count"] ?? 0;
    const row = this.#db
      .prepare("PRAGMA wal_checkpoint(0)")
      .get() as Record<string, number>;
    return {
      walSizePages: row?.[1] ?? 0,
      pageSize,
      pageCount,
      checkpointRequired: (row?.[1] ?? 0) > 100,
      lastCheckpointPages: row?.[2] ?? 0,
    };
  }

  #ensureOpen(): void {
    if (this.#closed) {
      throw new ConnectionError("Database is closed. No operations allowed.");
    }
  }

  #resolveConfig(options?: BunQLOptions): BunQLConfig {
    const retry: Required<RetryConfig> = {
      ...DEFAULT_RETRY_CONFIG,
      ...options?.retry,
    };

    const readerPoolSize = options?.readerPool ?? 0;

    return {
      wal: options?.wal ?? true,
      readonly: options?.readonly ?? false,
      busyTimeout: options?.busyTimeout ?? 5000,
      synchronous: options?.synchronous ?? "NORMAL",
      cacheSize: options?.cacheSize ?? -2000,
      foreignKeys: options?.foreignKeys ?? true,
      safeIntegers: options?.safeIntegers ?? false,
      retry,
      readerPoolSize,
      maintenance: options?.maintenance,
      slowQueryThreshold: options?.slowQueryThreshold ?? 0,
      metricsEnabled: options?.metricsEnabled ?? false,
      queryTimeoutMs: options?.queryTimeoutMs ?? 0,
      extractColumns: options?.extractColumns ?? false,
      autoVacuum: options?.pragma?.autoVacuum ?? "NONE",
      verbose: options?.verbose ?? null,
      transactionMode: options?.transactionMode ?? "immediate",
      logger: options?.logger,
      hooks: options?.hooks,
      events: options?.events,
    };
  }

  #setupEventHandlers(events?: EventHandlers): void {
    const userOnBusy = events?.onBusy;
    this.#retryPolicy.onBusy = (attempt, delay) => {
      if (this.#metricsEnabled) this.#metrics.writes.retried++;
      userOnBusy?.(attempt, delay);
    };

    const userOnRetry = events?.onRetry;
    this.#retryPolicy.onRetry = (attempt, delay, error) => {
      userOnRetry?.(attempt, delay, error);
    };

    if (events?.onDrain) {
      this.#writeQueue.onDrain = events.onDrain;
    }

    if (events?.onError) {
      this.#onError = events.onError;
    }
  }

  #startMaintenance(maintenance?: MaintenanceConfig): void {
    if (!maintenance) return;
    const intervals: number[] = [];

    if (maintenance.checkpoint?.enabled) {
      intervals.push(maintenance.checkpoint.intervalMs ?? 60000);
    }
    if (maintenance.vacuum?.enabled) {
      intervals.push(maintenance.vacuum.intervalMs ?? 60000);
    }
    if (maintenance.backup?.enabled) {
      intervals.push(maintenance.backup.intervalMs);
    }
    if (maintenance.integrityCheck?.enabled) {
      intervals.push(maintenance.integrityCheck.intervalMs);
    }

    if (intervals.length === 0) return;

    const intervalMs = Math.min(...intervals);

    this.#maintenanceTimer = setInterval(() => {
      if (this.#closed) return;
      this.#writeQueue.enqueue(async () => {
        if (maintenance.checkpoint?.enabled) {
          const status = this.#walStatusDirect();
          if (status.walSizePages > (maintenance.checkpoint.pagesThreshold ?? 1000)) {
            this.#checkpointDirect(maintenance.checkpoint.mode ?? "TRUNCATE");
          }
        }
        if (maintenance.vacuum?.enabled) {
          const pages = maintenance.vacuum.pagesPerStep ?? 100;
          if (maintenance.vacuum.mode === "full") {
            this.#db.exec("VACUUM");
          } else {
            this.#db.exec(`PRAGMA incremental_vacuum(${pages})`);
          }
        }
        if (maintenance.backup?.enabled) {
          const ts = new Date().toISOString().replace(/[:.]/g, "-");
          const path = `${maintenance.backup.path.replace(/\/$/, "")}/bunql-backup-${ts}.db`;
          this.#db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
        }
      }).catch((error) => {
        this.#log("error", `Maintenance task failed: ${error}`);
      });
    }, intervalMs);
  }

  #log(level: "debug" | "warn" | "info" | "error", message: string): void {
    this.#logger?.[level]?.(`[BunQL] ${message}`);
  }

  #verboseLog(sql: string): void {
    this.#verbose?.(sql);
  }
}

export type { TransactionContext } from "./transaction-manager.ts";
export type {
  BunQLOptions,
  RetryConfig,
  QueryResult,
  RunResult,
  Statement,
  ColumnInfo,
  BatchOperation,
  BunQLMetrics,
  CacheStats,
  CheckpointMode,
  CheckpointResult,
  WalStatus,
  BackupResult,
  VacuumResult,
  FTS5Options,
  FTSResult,
  MaintenanceConfig,
  TransactionMode,
  PragmaOptions,
} from "./types/index.ts";
export type { ServerOptions } from "./types/result.ts";
