import type { Statement as BunStatement, SQLQueryBindings } from "bun:sqlite";
import type { BunQLState } from "./bunql-state.ts";
import type { RunResult, BatchOperation, TransactionMode } from "./types/index.ts";
import { QueueError } from "./errors/queue-error.ts";

export const writeOps = {
  async transaction<T>(
    s: BunQLState,
    callback: (tx: import("./transaction-manager.ts").TransactionContext) => Promise<T>,
    mode?: TransactionMode,
  ): Promise<T> {
    s.ensureOpen();
    const txMode = mode ?? s.config.transactionMode;
    return s.retryPolicy.execute(async () => s.txManager.transaction(callback, txMode));
  },

  async batch(
    s: BunQLState,
    operations: BatchOperation[],
    executeBatch: (ops: BatchOperation[], getStmt: (sql: string) => BunStatement, hooks: { beforeWrite?: (sql: string, params: unknown[]) => void; afterWrite?: (sql: string, params: unknown[], ms: number) => void } | undefined) => RunResult[],
  ): Promise<RunResult[]> {
    s.ensureOpen();
    s.metricsData.writes.total++;
    return s.retryPolicy.execute(async () =>
      s.writeQueue.enqueue(async () => {
        try {
          s.db.run("BEGIN IMMEDIATE");
          const results = executeBatch(operations, (sql) => s.statementCache.get(sql), s.config.hooks as any);
          s.db.run("COMMIT");
          return results;
        } catch (error) {
          s.metricsData.writes.failed++;
          s.db.run("ROLLBACK");
          const err = error instanceof Error ? error : new Error(String(error));
          s.onError?.(err);
          throw new QueueError("Batch operation failed, transaction rolled back", { cause: err });
        }
      })
    );
  },

  async exec(s: BunQLState, sql: string): Promise<void> {
    s.ensureOpen();
    s.metricsData.writes.total++;
    await s.retryPolicy.execute(async () =>
      s.writeQueue.enqueue(async () => {
        try {
          s.db.exec(sql);
        } catch (error) {
          s.metricsData.writes.failed++;
          s.onError?.(error instanceof Error ? error : new Error(String(error)));
          throw new QueueError("Exec operation failed", {
            cause: error instanceof Error ? error : undefined,
          });
        }
      })
    );
  },
};
