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
          const stmt = this.#db.prepare(sql);
          try {
            const raw = stmt.run(...(params ?? []));
            return {
              changes: raw.changes,
              lastInsertRowid: raw.lastInsertRowid,
              durationMs: performance.now() - start,
            };
          } finally {
            stmt.finalize();
          }
        });
      });

      this.#config.hooks?.afterWrite?.(sql, params ?? [], performance.now() - start);
      return result;
    } catch (error) {
      throw new QueueError(
        "Write operation failed",
        { cause: error instanceof Error ? error : undefined },
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
      run: (...params: P): RunResult => {
        const result = stmt.run(...params);
        return {
          changes: result.changes,
          lastInsertRowid: result.lastInsertRowid,
          durationMs: 0,
        };
      },
      finalize: () => {
        stmt.finalize();
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
          const stmt = this.#db.prepare(op.sql);

          try {
            const raw = stmt.run(...((op.params ?? []) as SQLQueryBindings[]));
            const result: RunResult = {
              changes: raw.changes,
              lastInsertRowid: raw.lastInsertRowid,
              durationMs: performance.now() - start,
            };
            results.push(result);
            this.#config.hooks?.afterWrite?.(op.sql, op.params ?? [], performance.now() - start);
          } finally {
            stmt.finalize();
          }
        }

        this.#db.run("COMMIT");
        return results;
      } catch (error) {
        this.#db.run("ROLLBACK");
        throw new QueueError(
          "Batch operation failed, transaction rolled back",
          { cause: error instanceof Error ? error : undefined },
        );
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
      throw new ConnectionError(
        "Failed to close database",
        { cause: error instanceof Error ? error : undefined },
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
  }

  #log(level: "debug" | "warn" | "info" | "error", message: string): void {
    this.#logger?.[level]?.(`[BunQL] ${message}`);
  }
}

export type { BunQLOptions, RetryConfig, QueryResult, RunResult, Statement, BatchOperation, TransactionContext };
