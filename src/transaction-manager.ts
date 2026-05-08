import type { Database, SQLQueryBindings, Statement as BunStatement } from "bun:sqlite";
import { TransactionError } from "./errors/transaction-error.ts";
import type { RunResult, Statement } from "./types/result.ts";
import type { BunQLHooks, Logger, BatchOperation } from "./types/options.ts";
import { WriteQueue } from "./write-queue.ts";

export interface TransactionContext {
  run(sql: string, params?: SQLQueryBindings[]): Promise<RunResult>;
  query<T = unknown>(sql: string, params?: SQLQueryBindings[]): T[];
  prepare<T = unknown, P extends SQLQueryBindings[] = SQLQueryBindings[]>(sql: string): Statement<T, P>;
  batch(operations: BatchOperation[]): Promise<RunResult[]>;
}

export class TransactionManager {
  #db: Database;
  #writeQueue: WriteQueue;
  #savepointCounter = 0;
  #depth = 0;
  #hooks?: BunQLHooks;
  #logger?: Logger;

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
    if (this.#depth > 0) {
      return this.#nestedTransaction(callback);
    }

    return this.#writeQueue.enqueue(async () => {
      this.#depth++;
      const startTime = performance.now();
      const stmtCache = new Map<string, BunStatement>();
      try {
        this.#hooks?.beforeTransaction?.();
        this.#log("debug", "Beginning transaction");

        this.#db.run("BEGIN IMMEDIATE");

        const ctx = this.#createContext(stmtCache);

        let result: T;
        try {
          result = await callback(ctx);
        } catch (error) {
          this.#rollback(startTime, error instanceof Error ? error : undefined);
        }

        this.#db.run("COMMIT");
        const duration = performance.now() - startTime;
        this.#hooks?.afterTransaction?.(duration, true);
        this.#log("debug", `Transaction committed in ${duration.toFixed(2)}ms`);
        return result;
      } finally {
        for (const stmt of stmtCache.values()) {
          stmt.finalize();
        }
        this.#depth--;
      }
    });
  }

  async #nestedTransaction<T>(
    callback: (tx: TransactionContext) => Promise<T>,
  ): Promise<T> {
    const savepoint = `bunql_sp_${++this.#savepointCounter}`;
    const stmtCache = new Map<string, BunStatement>();

    try {
      this.#db.run(`SAVEPOINT ${savepoint}`);

      const ctx = this.#createContext(stmtCache);

      let result: T;
      try {
        result = await callback(ctx);
      } catch (error) {
        this.#db.run(`ROLLBACK TO ${savepoint}`);
        this.#log("debug", `Rolled back to savepoint: ${savepoint}`);
        throw new TransactionError("Nested transaction failed, rolled back to savepoint", {
          cause: error instanceof Error ? error : undefined,
        });
      }

      this.#db.run(`RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      if (error instanceof TransactionError) throw error;
      throw new TransactionError("Nested transaction failed", {
        cause: error instanceof Error ? error : undefined,
      });
    } finally {
      for (const stmt of stmtCache.values()) {
        stmt.finalize();
      }
    }
  }

  #rollback(startTime: number, originalError?: Error): never {
    this.#db.run("ROLLBACK");
    const duration = performance.now() - startTime;
    this.#hooks?.afterTransaction?.(duration, false);
    this.#log("warn", "Transaction rolled back");
    throw new TransactionError("Transaction failed and was rolled back", {
      cause: originalError,
    });
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