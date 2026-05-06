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

export interface Statement<T = unknown, P extends unknown[] = unknown[]> {
  all(...params: P): T[];
  get(...params: P): T | undefined;
  run(...params: P): RunResult;
  finalize(): void;
}