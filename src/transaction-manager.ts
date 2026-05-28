/**
 * @module transaction-manager
 * @description Serialized transaction execution with SAVEPOINT nesting support.
 */
import type { Database, SQLQueryBindings, Statement as BunStatement } from "bun:sqlite";
import type { RunResult, Statement } from "./types/result.ts";
import type { BunQLHooks, Logger, BatchOperation } from "./types/options.ts";
import { WriteQueue } from "./write-queue.ts";

export interface TransactionContext {
  run(sql: string, params?: SQLQueryBindings[]): Promise<RunResult>;
  query<T = unknown>(sql: string, params?: SQLQueryBindings[]): T[];
  prepare<T = unknown, P extends SQLQueryBindings[] = SQLQueryBindings[]>(sql: string): Statement<T, P>;
  batch(operations: BatchOperation[]): Promise<RunResult[]>;
}

export interface TxMetrics {
  committed: number;
  rolledBack: number;
}

export class TransactionManager {
  #db: Database;
  #writeQueue: WriteQueue;
  #savepointCounter = 0;
  #depth = 0;
  #processing = false;
  #hooks?: BunQLHooks;
  #logger?: Logger;
  #committed = 0;
  #rolledBack = 0;

  get metrics(): TxMetrics {
    return { committed: this.#committed, rolledBack: this.#rolledBack };
  }

  constructor(
    db: Database,
    writeQueue: WriteQueue,
    hooks?: BunQLHooks,
    logger?: Logger,
  ) {
    this.#db = db;
    this.#writeQueue = writeQueue;
    this.#hooks = hooks;
    this.#logger = logger;
  }

  async transaction<T>(
    callback: (tx: TransactionContext) => Promise<T>,
  ): Promise<T> {
    if (this.#processing && this.#depth > 0) {
      return this.#nestedTransaction(callback);
    }

    return this.#writeQueue.enqueue(async () => {
      this.#processing = true;
      this.#depth++;
      const startTime = performance.now();
      const stmtCache = new Map<string, BunStatement>();
      // eslint-disable-next-line no-useless-assignment
      let began = false;
      try {
        this.#hooks?.beforeTransaction?.();
        this.#log("debug", "Beginning transaction");

        this.#db.run("BEGIN IMMEDIATE");
        began = true;

        const ctx = this.#createContext(stmtCache);

        let result: T;
        try {
          result = await callback(ctx);
        } catch (error) {
          const originalError = error instanceof Error ? error : new Error(String(error));
          if (began) this.#db.run("ROLLBACK");
          this.#rolledBack++;
          const duration = performance.now() - startTime;
          this.#hooks?.afterTransaction?.(duration, false);
          this.#log("warn", "Transaction rolled back");
          throw originalError;
        }

        this.#db.run("COMMIT");
        this.#committed++;
        const duration = performance.now() - startTime;
        this.#hooks?.afterTransaction?.(duration, true);
        this.#log("debug", `Transaction committed in ${duration.toFixed(2)}ms`);
        return result;
      } finally {
        for (const stmt of stmtCache.values()) {
          stmt.finalize();
        }
        this.#depth--;
        this.#processing = false;
      }
    });
  }

  async #nestedTransaction<T>(
    callback: (tx: TransactionContext) => Promise<T>,
  ): Promise<T> {
    const startTime = performance.now();
    const savepoint = `bunql_sp_${++this.#savepointCounter}`;
    const stmtCache = new Map<string, BunStatement>();

    try {
      this.#db.run(`SAVEPOINT ${savepoint}`);

      const ctx = this.#createContext(stmtCache);

      let result: T;
      try {
        result = await callback(ctx);
      } catch (error) {
        const originalError = error instanceof Error ? error : new Error(String(error));
        const duration = performance.now() - startTime;
        this.#hooks?.afterTransaction?.(duration, false);
        this.#db.run(`ROLLBACK TO ${savepoint}`);
        this.#log("debug", `Rolled back to savepoint: ${savepoint}`);
        this.#rolledBack++;
        throw originalError;
      }

      this.#db.run(`RELEASE ${savepoint}`);
      return result;
    } finally {
      for (const stmt of stmtCache.values()) {
        stmt.finalize();
      }
    }
  }

  #createContext(stmtCache: Map<string, BunStatement>): TransactionContext {
    const getOrPrepare = (sql: string): BunStatement => {
      let stmt = stmtCache.get(sql);
      if (!stmt) {
        stmt = this.#db.prepare(sql);
        stmtCache.set(sql, stmt);
      }
      return stmt;
    };

    const executeRun = (sql: string, params?: SQLQueryBindings[]): RunResult => {
      const start = performance.now();
      const stmt = getOrPrepare(sql);
      const result = stmt.run(...(params ?? []));
      return {
        changes: result.changes,
        lastInsertRowid: result.lastInsertRowid,
        durationMs: performance.now() - start,
      };
    };

    const executeQuery = <T>(sql: string, params?: SQLQueryBindings[]): T[] => {
      const stmt = getOrPrepare(sql);
      return stmt.all(...(params ?? [])) as T[];
    };

    const executePrepare = <T, P extends SQLQueryBindings[]>(sql: string): Statement<T, P> => {
      const stmt = getOrPrepare(sql);
      return {
        all: (...params: P): T[] => stmt.all(...params) as T[],
        get: (...params: P): T | undefined => stmt.get(...params) as T | undefined,
        run: (...params: P): Promise<RunResult> => {
          const start = performance.now();
          const result = stmt.run(...params);
          return Promise.resolve({
            changes: result.changes,
            lastInsertRowid: result.lastInsertRowid,
            durationMs: performance.now() - start,
          });
        },
        finalize: () => stmt.finalize(),
      };
    };

    const executeBatch = async (operations: BatchOperation[]): Promise<RunResult[]> => {
      const results: RunResult[] = [];
      for (const op of operations) {
        const start = performance.now();
        const stmt = getOrPrepare(op.sql);
        const raw = stmt.run(...(op.params ?? []));
        results.push({
          changes: raw.changes,
          lastInsertRowid: raw.lastInsertRowid,
          durationMs: performance.now() - start,
        });
      }
      return results;
    };

    return {
      run: async (sql: string, params?: SQLQueryBindings[]): Promise<RunResult> => {
        return Promise.resolve(executeRun(sql, params));
      },
      query: <T>(sql: string, params?: SQLQueryBindings[]): T[] => executeQuery<T>(sql, params),
      prepare: <T, P extends SQLQueryBindings[]>(sql: string): Statement<T, P> => executePrepare<T, P>(sql),
      batch: (operations: BatchOperation[]): Promise<RunResult[]> => executeBatch(operations),
    };
  }

  #log(level: "debug" | "warn" | "error", message: string): void {
    this.#logger?.[level]?.(`[BunQL:Transaction] ${message}`);
  }
}