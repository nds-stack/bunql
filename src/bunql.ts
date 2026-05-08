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

  query<T = Record<string, unknown>>(sql: string, params?: SQLQueryBindings[]): QueryResult<T> {
    this.#ensureOpen();

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
    return this.#transactionManager.transaction(callback);
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
    if (!events) return;

    if (events.onBusy) {
      this.#retryPolicy.onBusy = events.onBusy;
    }

    if (events.onRetry) {
      this.#retryPolicy.onRetry = events.onRetry;
    }

    if (events.onDrain) {
      this.#writeQueue.onDrain = events.onDrain;
    }

    if (events.onError) {
      this.#onError = events.onError;
    }
  }

  #log(level: "debug" | "warn" | "info" | "error", message: string): void {
    this.#logger?.[level]?.(`[BunQL] ${message}`);
  }
}

export type { BunQLOptions, RetryConfig, QueryResult, RunResult, Statement, BatchOperation, TransactionContext };
