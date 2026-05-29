import type { Statement as BunStatement, SQLQueryBindings } from "bun:sqlite";
import { StatementCache } from "./statement-cache.ts";
import type { Statement, RunResult, ColumnInfo } from "./types/index.ts";

interface StmtInternals {
  raw: boolean;
  pluck: boolean;
  safeInts: boolean;
  bound: SQLQueryBindings[] | null;
}

export function createStatementWrapper<T, P extends SQLQueryBindings[]>(
  sql: string,
  cache: StatementCache,
  safeIntegers: boolean,
  metricsEnabled: boolean,
  verboseLog: (sql: string) => void,
): Statement<T, P> {
  const native: BunStatement = cache.get(sql);
  const internals: StmtInternals = {
    raw: false, pluck: false, safeInts: safeIntegers, bound: null,
  };

  const applyParams = (params?: SQLQueryBindings[]): unknown[] =>
    !params || params.length === 0 ? internals.bound ?? [] : params;

  const transformRow = <R>(row: unknown): R => {
    if (internals.pluck) {
      if (Array.isArray(row)) return (row as unknown[])[0] as R;
      return (Object.values(row as Record<string, unknown>))[0] as R;
    }
    return row as R;
  };

  const getReader = (): boolean => {
    const trimmed = sql.trimStart().toUpperCase();
    return trimmed.startsWith("SELECT") || trimmed.startsWith("WITH") || trimmed.startsWith("PRAGMA");
  };

  const stmt: Statement<T, P> = {
    all: (...params: P): T[] => {
      verboseLog(sql);
      const effective = applyParams(params as unknown as SQLQueryBindings[]);
      if (internals.raw) {
        const rows = native.values(...effective) as unknown[][];
        if (internals.pluck) return rows.map((r) => (r.length > 0 ? r[0] : undefined)) as T[];
        return rows as T[];
      }
      const rows = native.all(...effective) as unknown[];
      return rows.map((r) => transformRow<T>(r));
    },

    get: (...params: P): T | undefined => {
      verboseLog(sql);
      const effective = applyParams(params as unknown as SQLQueryBindings[]);
      if (internals.raw) {
        const rows = native.values(...effective) as unknown[][];
        if (rows.length === 0) return undefined;
        const first = rows[0] as unknown[];
        if (internals.pluck) return (first.length > 0 ? first[0] : undefined) as T;
        return first as T;
      }
      const row = native.get(...effective) as unknown;
      if (row === undefined || row === null) return undefined;
      return transformRow<T>(row);
    },

    run: (...params: P): RunResult => {
      verboseLog(sql);
      const effective = applyParams(params as unknown as SQLQueryBindings[]);
      const start = metricsEnabled ? performance.now() : 0;
      const result = native.run(...effective);
      return {
        changes: result.changes,
        lastInsertRowid: result.lastInsertRowid,
        durationMs: metricsEnabled ? performance.now() - start : 0,
      };
    },

    values: (...params: P): unknown[][] => {
      verboseLog(sql);
      return native.values(...applyParams(params as unknown as SQLQueryBindings[]));
    },

    iterate: (...params: P): IterableIterator<T> => {
      verboseLog(sql);
      const effective = applyParams(params as unknown as SQLQueryBindings[]);
      const useValues = internals.raw;
      const nativeIter = (native as unknown as { iterate?(...p: unknown[]): IterableIterator<unknown> }).iterate;
      const iter = (useValues || !nativeIter)
        ? native.values(...effective)[Symbol.iterator]()
        : nativeIter.call(native, ...effective);
      return {
        [Symbol.iterator](): IterableIterator<T> { return this; },
        next(): IteratorResult<T> {
          const { value, done } = iter.next();
          if (done) return { value: undefined as unknown as T, done: true };
          if (internals.raw) {
            if (internals.pluck) return { value: (Array.isArray(value) && (value as unknown[]).length > 0 ? (value as unknown[])[0] : undefined) as T, done: false };
            return { value: value as T, done: false };
          }
          return { value: transformRow<T>(value), done: false };
        },
      } as IterableIterator<T>;
    },

    finalize: (): void => { cache.remove(sql); },

    raw: (toggle?: boolean): Statement<unknown[], P> => {
      internals.raw = toggle !== false;
      if (internals.raw) internals.pluck = false;
      return stmt as unknown as Statement<unknown[], P>;
    },

    pluck: (toggle?: boolean): Statement<unknown, P> => {
      internals.pluck = toggle !== false;
      if (internals.pluck) internals.raw = false;
      return stmt as unknown as Statement<unknown, P>;
    },

    columns: (): ColumnInfo[] => native.columnNames.map((name) => ({ name, column: null, table: null, database: null, type: null })),

    bind: (...params: P): Statement<T, P> => { internals.bound = params as unknown as SQLQueryBindings[]; return stmt; },

    safeIntegers: (toggle?: boolean): Statement<T, P> => { internals.safeInts = toggle !== false; return stmt; },

    as: <U>(Class: new (...args: unknown[]) => U): Statement<U, P> => {
      const base = stmt as unknown as Statement<unknown, P>;
      const mapRow = (r: unknown): U => Object.assign(Object.create(Class.prototype), r) as U;
      const wrapped: Statement<U, P> = {
        all: (...params: P): U[] => base.all(...params).map((r) => mapRow(r)),
        get: (...params: P): U | undefined => { const row = base.get(...params); return row === undefined || row === null ? undefined : mapRow(row); },
        run: base.run,
        values: base.values,
        iterate(...params: P): IterableIterator<U> {
          const iter = base.iterate(...params);
          return {
            [Symbol.iterator]() { return this; },
            next(): IteratorResult<U> {
              const { value, done } = iter.next();
              if (done) return { value: undefined as unknown as U, done: true };
              return { value: mapRow(value), done: false };
            },
          };
        },
        finalize: base.finalize,
        raw: ((toggle?: boolean) => base.raw(toggle)) as unknown as Statement<U, P>["raw"],
        pluck: ((toggle?: boolean) => base.pluck(toggle)) as unknown as Statement<U, P>["pluck"],
        columns: base.columns,
        bind: ((...params: P) => base.bind(...params)) as unknown as Statement<U, P>["bind"],
        safeIntegers: ((toggle?: boolean) => base.safeIntegers(toggle)) as unknown as Statement<U, P>["safeIntegers"],
        as: (<V>(C: new (...args: unknown[]) => V) => base.as(C)) as unknown as Statement<U, P>["as"],
        get source() { return base.source; },
        get reader() { return base.reader; },
      };
      return wrapped;
    },

    get source(): string { return native.toString(); },
    get reader(): boolean { return getReader(); },
  };

  return stmt;
}
