/**
 * @module types-result
 * @description Result type definitions for all API methods.
 */
export interface QueryResult<T = unknown> {
  rows: T[];
  columns: string[];
  durationMs: number;
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint | null;
  durationMs: number;
}

export interface ColumnInfo {
  name: string;
  column: string | null;
  table: string | null;
  database: string | null;
  type: string | null;
}

export interface Statement<T = unknown, P extends unknown[] = unknown[]> {
  all(...params: P): T[];
  get(...params: P): T | undefined;
  run(...params: P): RunResult;
  values(...params: P): unknown[][];
  iterate(...params: P): IterableIterator<T>;
  finalize(): void;

  raw(toggle?: boolean): Statement<unknown[], P>;
  pluck(toggle?: boolean): Statement<unknown, P>;
  columns(): ColumnInfo[];
  bind(...params: P): Statement<T, P>;
  safeIntegers(toggle?: boolean): Statement<T, P>;
  as<U>(Class: new (...args: unknown[]) => U): Statement<U, P>;

  readonly source: string;
  readonly reader: boolean;
}

export interface BunQLMetrics {
  writes: { total: number; failed: number; retried: number };
  reads: { total: number };
  queue: { currentSize: number; peakSize: number; totalEnqueued: number };
  transactions: { committed: number; rolledBack: number };
}

export interface CacheStats {
  size: number;
  hits: number;
  misses: number;
  hitRate: number;
}

export type CheckpointMode = "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE";

export interface CheckpointResult {
  pagesCheckpointed: number;
  walSizeBytes: number;
}

export interface WalStatus {
  walSizePages: number;
  pageSize: number;
  pageCount: number;
  checkpointRequired: boolean;
  lastCheckpointPages: number;
}

export interface BackupResult {
  size: number;
  durationMs: number;
}

export interface FTSResult {
  rank: number;
  [column: string]: unknown;
}

export interface VacuumResult {
  pagesReclaimed: number;
  durationMs: number;
}

export interface ServerOptions {
  port?: number;
  host?: string;
  auth?: { apiKey: string };
  maxConnections?: number;
  cors?: boolean;
}
