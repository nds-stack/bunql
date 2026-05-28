/**
 * @module transaction-manager
 * @description Serialized transaction execution with SAVEPOINT nesting support.
 */
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { WriteQueue } from "./write-queue.ts";
import type { BunQLHooks, Logger, TransactionMode } from "./types/options.ts";
import { createTxContext } from "./transaction-context.ts";

export interface TransactionContext {
  run(sql: string, params?: SQLQueryBindings[]): import("./types/result.ts").RunResult;
  query<T = unknown>(sql: string, params?: SQLQueryBindings[]): T[];
  prepare<T = unknown, P extends SQLQueryBindings[] = SQLQueryBindings[]>(sql: string): {
    all(...params: P): T[];
    get(...params: P): T | undefined;
    run(...params: P): import("./types/result.ts").RunResult;
    finalize(): void;
  };
  batch(operations: import("./types/options.ts").BatchOperation[]): import("./types/result.ts").RunResult[];
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

  get depth(): number {
    return this.#depth;
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
    mode: TransactionMode = "immediate",
  ): Promise<T> {
    if (this.#processing && this.#depth > 0) {
      return this.#nestedTransaction(callback);
    }

    return this.#writeQueue.enqueue(async () => {
      this.#processing = true;
      this.#depth++;
      const startTime = performance.now();
      const stmtCache = new Map<string, import("bun:sqlite").Statement>();
      let began = false;
      try {
        this.#hooks?.beforeTransaction?.();
        this.#log("debug", `Beginning transaction (${mode})`);

        const beginSQL = mode === "deferred"
          ? "BEGIN DEFERRED"
          : mode === "exclusive"
            ? "BEGIN EXCLUSIVE"
            : "BEGIN IMMEDIATE";
        this.#db.run(beginSQL);
        began = true;

        const ctx = createTxContext(this.#db, stmtCache);

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
    const stmtCache = new Map<string, import("bun:sqlite").Statement>();

    try {
      this.#db.run(`SAVEPOINT ${savepoint}`);

      const ctx = createTxContext(this.#db, stmtCache);

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

  #log(level: "debug" | "warn" | "error", message: string): void {
    this.#logger?.[level]?.(`[BunQL:Transaction] ${message}`);
  }
}