/**
 * @module driver/adapter
 * @description DriverAdapter interface — all database drivers implement this.
 */

export interface RunResult {
  changes: number;
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
