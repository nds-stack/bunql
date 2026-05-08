import { Database, type SQLQueryBindings } from "bun:sqlite";
import { WriteQueue } from "./write-queue.ts";
import { RetryPolicy, DEFAULT_RETRY_CONFIG } from "./retry-policy.ts";
import { TransactionManager, type TransactionContext } from "./transaction-manager.ts";
import { StatementCache } from "./statement-cache.ts";
import { ConnectionError } from "./errors/connection-error.ts";
import { QueueError } from "./errors/queue-error.ts";
import type {
  BunQLOptions,
  BunQLConfig,
  QueryResult,
  RunResult,
  Statement,
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
} from "./types/index.ts";

export class BunQL {
  #db: Database;
  #config: BunQLConfig;
  #writeQueue: WriteQueue;
  #retryPolicy: RetryPolicy;
  #transactionManager: TransactionManager;
  #statementCache: StatementCache;
  #closed = false;
  #logger?: Logger;
  #onError?: (error: Error) => void;
  #metrics: BunQLMetrics = {
    writes: { total: 0, failed: 0, retried: 0 },
    reads: { total: 0 },
    queue: { currentSize: 0, peakSize: 0, totalEnqueued: 0 },
    transactions: { committed: 0, rolledBack: 0 },
  };

  constructor(path: string, options?: BunQLOptions) {
    const config = this.#resolveConfig(options);
    this.#config = config;
    this.#logger = config.logger;

    try {
      if (config.readonly) {
        this.#db = new Database(path, { readonly: true });
      } else {
        this.#db = new Database(path);
      }
    } catch (error) {
      throw new ConnectionError(
        `Failed to open database: ${path}`,
        { cause: error instanceof Error ? error : undefined },
      );
    }

    if (config.wal) {
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

    this.#writeQueue = new WriteQueue();
    this.#retryPolicy = new RetryPolicy(config.retry);
    this.#statementCache = new StatementCache(this.#db);
    this.#transactionManager = new TransactionManager(
      this.#db,
      this.#writeQueue,
      config.hooks,
      this.#logger,
    );

    this.#setupEventHandlers(config.events);
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

  get raw(): Database {
    this.#ensureOpen();
    return this.#db;
  }

  get metrics(): BunQLMetrics {
    return {
      ...this.#metrics,
      queue: {
        ...this.#metrics.queue,
        currentSize: this.#writeQueue.size,
        peakSize: this.#writeQueue.peakSize,
        totalEnqueued: this.#writeQueue.totalEnqueued,
      },
    };
  }

  get cacheStats(): CacheStats {
    const hits = this.#statementCache.hits;
    const misses = this.#statementCache.misses;
    const total = hits + misses;
    return {
      size: this.#statementCache.size,
      hits,
      misses,
      hitRate: total > 0 ? hits / total : 0,
    };
  }

  query<T = Record<string, unknown>>(sql: string, params?: SQLQueryBindings[]): QueryResult<T> {
    this.#ensureOpen();

    this.#metrics.reads.total++;
    const start = performance.now();
    const stmt = this.#statementCache.get(sql);
    const rows = stmt.all(...(params ?? [])) as T[];
    const columns = rows.length > 0 ? Object.keys(rows[0] as Record<string, unknown>) : [];

    return {
      rows,
      columns,
      durationMs: performance.now() - start,
    };
  }

  async run(sql: string, params?: SQLQueryBindings[]): Promise<RunResult> {
    this.#ensureOpen();

    this.#metrics.writes.total++;
    const start = performance.now();
    this.#config.hooks?.beforeWrite?.(sql, params ?? []);

    try {
      const result = await this.#writeQueue.enqueue(async () => {
        return await this.#retryPolicy.execute(async () => {
          const stmt = this.#statementCache.get(sql);
          const raw = stmt.run(...(params ?? []));
          return {
            changes: raw.changes,
            lastInsertRowid: raw.lastInsertRowid,
            durationMs: performance.now() - start,
          };
        });
      });

      this.#config.hooks?.afterWrite?.(sql, params ?? [], performance.now() - start);
      return result;
    } catch (error) {
      this.#metrics.writes.failed++;
      const err = error instanceof Error ? error : new Error(String(error));
      this.#onError?.(err);
      throw new QueueError(
        "Write operation failed",
        { cause: err },
      );
    }
  }

  async transaction<T>(
    callback: (tx: TransactionContext) => Promise<T>,
  ): Promise<T> {
    this.#ensureOpen();
    try {
      const result = await this.#transactionManager.transaction(callback);
      this.#metrics.transactions.committed++;
      return result;
    } catch (error) {
      this.#metrics.transactions.rolledBack++;
      throw error;
    }
  }

  prepare<T = unknown, P extends SQLQueryBindings[] = SQLQueryBindings[]>(
    sql: string,
  ): Statement<T, P> {
    this.#ensureOpen();

    const stmt = this.#statementCache.get(sql);

    return {
      all: (...params: P): T[] => {
        return stmt.all(...params) as T[];
      },
      get: (...params: P): T | undefined => {
        return stmt.get(...params) as T | undefined;
      },
      run: async (...params: P): Promise<RunResult> => {
        return this.#writeQueue.enqueue(async () => {
          const start = performance.now();
          const result = stmt.run(...params);
          return {
            changes: result.changes,
            lastInsertRowid: result.lastInsertRowid,
            durationMs: performance.now() - start,
          };
        });
      },
      finalize: () => {
        this.#statementCache.remove(sql);
      },
    };
  }

  async batch(operations: BatchOperation[]): Promise<RunResult[]> {
    this.#ensureOpen();

    return this.#writeQueue.enqueue(async () => {
      const results: RunResult[] = [];

      try {
        this.#db.run("BEGIN IMMEDIATE");

        for (const op of operations) {
          this.#config.hooks?.beforeWrite?.(op.sql, op.params ?? []);
          const start = performance.now();
          const stmt = this.#statementCache.get(op.sql);
          const raw = stmt.run(...(op.params ?? []));
          const result: RunResult = {
            changes: raw.changes,
            lastInsertRowid: raw.lastInsertRowid,
            durationMs: performance.now() - start,
          };
          results.push(result);
          this.#config.hooks?.afterWrite?.(op.sql, op.params ?? [], performance.now() - start);
        }

        this.#db.run("COMMIT");
        return results;
      } catch (error) {
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

    await this.#writeQueue.enqueue(async () => {
      try {
        this.#db.exec(sql);
      } catch (error) {
        this.#onError?.(error instanceof Error ? error : new Error(String(error)));
        throw new QueueError("Exec operation failed", {
          cause: error instanceof Error ? error : undefined,
        });
      }
    });
  }

  async checkpoint(mode: CheckpointMode = "PASSIVE"): Promise<CheckpointResult> {
    this.#ensureOpen();
    const modeMap: Record<CheckpointMode, number> = {
      PASSIVE: 0, FULL: 1, RESTART: 2, TRUNCATE: 3,
    };

    return this.#writeQueue.enqueue(async () => {
      const row = this.#db
        .prepare(`PRAGMA wal_checkpoint(${modeMap[mode]})`)
        .get() as Record<string, number>;
      return {
        pagesCheckpointed: row?.[1] ?? 0,
        walSizeBytes: 0,
      };
    });
  }

  async walStatus(): Promise<WalStatus> {
    this.#ensureOpen();

    return this.#writeQueue.enqueue(async () => {
      const pageSize = (this.#db
        .prepare("PRAGMA page_size")
        .get() as Record<string, number>)?.["page_size"] ?? 4096;
      const pageCount = (this.#db
        .prepare("PRAGMA page_count")
        .get() as Record<string, number>)?.["page_count"] ?? 0;
      const walSizePages = (this.#db
        .prepare("PRAGMA wal_checkpoint(0)")
        .get() as Record<string, number>)?.[1] ?? 0;

      return {
        walSizePages,
        pageSize,
        pageCount,
        checkpointRequired: walSizePages > 100,
        lastCheckpointPages: 0,
      };
    });
  }

  async backup(path: string): Promise<BackupResult> {
    this.#ensureOpen();
    const start = performance.now();

    await this.#writeQueue.enqueue(async () => {
      this.#db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
    });

    return { size: 0, durationMs: performance.now() - start };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    this.#writeQueue.close();

    try {
      await this.#writeQueue.drain();
    } catch {
      // drain completed or timed out
    }

    this.#statementCache.clear();

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

    return {
      wal: options?.wal ?? true,
      readonly: options?.readonly ?? false,
      busyTimeout: options?.busyTimeout ?? 5000,
      synchronous: options?.synchronous ?? "NORMAL",
      cacheSize: options?.cacheSize ?? -2000,
      foreignKeys: options?.foreignKeys ?? true,
      retry,
      logger: options?.logger,
      hooks: options?.hooks,
      events: options?.events,
    };
  }

  #setupEventHandlers(events?: EventHandlers): void {
    const userOnBusy = events?.onBusy;
    this.#retryPolicy.onBusy = (attempt, delay) => {
      this.#metrics.writes.retried++;
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

  #log(level: "debug" | "warn" | "info" | "error", message: string): void {
    this.#logger?.[level]?.(`[BunQL] ${message}`);
  }
}

export type { BunQLOptions, RetryConfig, QueryResult, RunResult, Statement, BatchOperation, TransactionContext, BunQLMetrics, CacheStats, CheckpointMode, CheckpointResult, WalStatus, BackupResult };
