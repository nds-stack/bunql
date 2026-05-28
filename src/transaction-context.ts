/**
 * @module transaction-context
 * @description Creates TransactionContext with statement caching for transaction callbacks.
 */
import type { Database, SQLQueryBindings, Statement as BunStatement } from "bun:sqlite";
import type { RunResult } from "./types/result.ts";
import type { BatchOperation } from "./types/options.ts";
import type { TransactionContext } from "./transaction-manager.ts";

export function createTxContext(
  db: Database,
  stmtCache: Map<string, BunStatement>,
): TransactionContext {
  const getOrPrepare = (sql: string): BunStatement => {
    let stmt = stmtCache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
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

  const executePrepare = <T, P extends SQLQueryBindings[]>(sql: string) => {
    const stmt = getOrPrepare(sql);
    return {
      all: (...params: P): T[] => stmt.all(...params) as T[],
      get: (...params: P): T | undefined => stmt.get(...params) as T | undefined,
      run: (...params: P): RunResult => {
        const start = performance.now();
        const result = stmt.run(...params);
        return {
          changes: result.changes,
          lastInsertRowid: result.lastInsertRowid,
          durationMs: performance.now() - start,
        };
      },
      finalize: () => stmt.finalize(),
    };
  };

  const executeBatch = (operations: BatchOperation[]): RunResult[] => {
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
    run: (sql: string, params?: SQLQueryBindings[]): RunResult => {
      return executeRun(sql, params);
    },
    query: <T>(sql: string, params?: SQLQueryBindings[]): T[] => executeQuery<T>(sql, params),
    prepare: <T, P extends SQLQueryBindings[]>(sql: string) => executePrepare<T, P>(sql),
    batch: (operations: BatchOperation[]): RunResult[] => executeBatch(operations),
  };
}
