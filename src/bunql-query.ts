import type { SQLQueryBindings } from "bun:sqlite";
import type { BunQLState } from "./bunql-state.ts";
import type { QueryResult, RunResult } from "./types/index.ts";

export const queryOps = {
  query<T = Record<string, unknown>>(s: BunQLState, sql: string, params?: SQLQueryBindings[]): QueryResult<T> {
    s.ensureOpen();
    s.verboseLog(sql);
    if (s.metricsEnabled) s.metricsData.reads.total++;
    const start = s.metricsEnabled ? performance.now() : 0;
    let timer: Timer | undefined;
    if (s.queryTimeoutMs > 0) {
      timer = setTimeout(() => (s.db as unknown as { interrupt(): void }).interrupt(), s.queryTimeoutMs);
    }
    let rows: T[];
    try {
      if (s.readerPool) {
        const entry = s.readerPool.next();
        rows = entry.cache.get(sql).all(...(params ?? [])) as T[];
      } else {
        rows = s.statementCache.get(sql).all(...(params ?? [])) as T[];
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
    const durationMs = s.metricsEnabled ? performance.now() - start : 0;
    if (s.config.slowQueryThreshold > 0 && durationMs > s.config.slowQueryThreshold) {
      s.config.events?.onSlowQuery?.(sql, durationMs);
    }
    const columns = s.extractColumns && rows.length > 0 ? Object.keys(rows[0] as Record<string, unknown>) : [];
    return { rows, columns, durationMs };
  },

  querySync<T = Record<string, unknown>>(s: BunQLState, sql: string, params?: SQLQueryBindings[]): QueryResult<T> {
    s.ensureOpen();
    s.verboseLog(sql);
    const start = s.metricsEnabled ? performance.now() : 0;
    const stmt = s.statementCache.get(sql);
    const rows = stmt.all(...(params ?? [])) as T[];
    const durationMs = s.metricsEnabled ? performance.now() - start : 0;
    const columns = s.extractColumns && rows.length > 0 ? Object.keys(rows[0] as Record<string, unknown>) : [];
    return { rows, columns, durationMs };
  },
};

export const runQueryOps = {
  run(s: BunQLState, sql: string, params?: SQLQueryBindings[]): RunResult {
    s.ensureOpen();
    s.verboseLog(sql);
    if (s.metricsEnabled) s.metricsData.writes.total++;
    const start = s.metricsEnabled ? performance.now() : 0;
    const stmt = s.statementCache.get(sql);
    const raw = stmt.run(...(params ?? []));
    const result: RunResult = {
      changes: raw.changes,
      lastInsertRowid: raw.lastInsertRowid,
      durationMs: s.metricsEnabled ? performance.now() - start : 0,
    };
    if (s.config.slowQueryThreshold > 0 && result.durationMs > s.config.slowQueryThreshold) {
      s.config.events?.onSlowQuery?.(sql, result.durationMs);
    }
    return result;
  },
};
