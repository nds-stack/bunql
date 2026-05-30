/**
 * @module driver/adapter
 * @description DriverAdapter interface — all database drivers implement this.
 */

export interface RunResult {
  changes: number;
  /**
   * Last inserted row ID — backend-specific behavior:
   * - SQLite: number (native support via last_insert_rowid())
   * - PostgreSQL: bigint (via RETURNING clause)
   * - MySQL: number (only for AUTO_INCREMENT columns; 0 otherwise)
   * - MongoDB: number | bigint (inserted _id as number or hex bigint)
   * - Redis: 0 (no rowid concept — returns number of affected keys)
   */
  lastInsertRowid: number | bigint;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  duration: number;
}

export interface DriverAdapter {
  query(sql: string, params?: unknown[]): QueryResult | Promise<QueryResult>;
  run(sql: string, params?: unknown[]): RunResult | Promise<RunResult>;
  close(): Promise<void>;
}
