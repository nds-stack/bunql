/**
 * @module query/sql-builder
 * @description SQL query builder — tagged template + chain API with cross-backend support.
 */

import { parseSQL } from "../parser/sql-parser.ts";
import { ParseError } from "../parser/sql-parser.ts";
import { astToSQL } from "../translator/to-sql.ts";
import type { RelationMap, RelationsResult } from "./relations/relations.ts";
import { fetchOne, fetchMany } from "./relations/relations.ts";

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  duration?: number;
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export type QueryExecutor = {
  executeSQL: (sql: string, params: unknown[]) => QueryResult | Promise<QueryResult>;
  executeRun: (sql: string, params: unknown[]) => RunResult | Promise<RunResult>;
  isAsync: boolean;
};

function buildSQL(strings: TemplateStringsArray, values: unknown[]): { sql: string; params: unknown[] } {
  let sql = "";
  const params: unknown[] = [];
  for (let i = 0; i < strings.length; i++) {
    sql += strings[i]!;
    if (i < values.length) {
      const v = values[i];
      if (Array.isArray(v)) {
        const placeholders = v.map(() => "?").join(", ");
        sql += placeholders;
        params.push(...v);
      } else {
        sql += "?";
        params.push(v);
      }
    }
  }
  return { sql, params };
}

export class SqlQuery<T extends Record<string, unknown> = Record<string, unknown>> {
  readonly sql: string;
  readonly params: unknown[];
  readonly #executor: QueryExecutor | null;
  readonly #node: ReturnType<typeof parseSQL> | null;

  constructor(sql: string, params: unknown[], executor?: QueryExecutor) {
    this.sql = sql;
    this.params = params;
    this.#executor = executor ?? null;

    let node: ReturnType<typeof parseSQL> | null = null;
    try {
      node = parseSQL(sql);
    } catch {
      // If parsing fails, fall back to raw execution (SQLite direct)
    }
    this.#node = node;
  }

  all(): T[] | Promise<T[]> {
    const result = this.#executor?.executeSQL(this.sql, this.params);
    if (result instanceof Promise) {
      return result.then((r) => r.rows as T[]);
    }
    return (result?.rows ?? []) as T[];
  }

  get(): T | null | Promise<T | null> {
    const result = this.#executor?.executeSQL(this.sql, this.params);
    if (result instanceof Promise) {
      return result.then((r) => (r.rows.length > 0 ? (r.rows[0] as T) : null));
    }
    return (result?.rows[0] as T) ?? null;
  }

  run(): RunResult | Promise<RunResult> {
    return this.#executor!.executeRun(this.sql, this.params);
  }

  with<R extends RelationMap>(relations: R): RelationsQuery<T, R> {
    return new RelationsQuery(this, relations);
  }

  toSQL(): string {
    if (this.#node) {
      const result = astToSQL(this.#node as Parameters<typeof astToSQL>[0]);
      return result.sql;
    }
    return this.sql;
  }

  get _executor(): QueryExecutor {
    if (!this.#executor) throw new Error("No executor provided");
    return this.#executor;
  }
}

export class RelationsQuery<T extends Record<string, unknown>, R extends RelationMap> {
  readonly #parent: SqlQuery<T>;
  readonly #relations: R;

  constructor(parent: SqlQuery<T>, relations: R) {
    this.#parent = parent;
    this.#relations = relations;
  }

  all(): RelationsResult<T, R>[] | Promise<RelationsResult<T, R>[]> {
    const executor = this.#parent._executor;
    const result = executor.executeSQL(this.#parent.sql, this.#parent.params);
    if (result instanceof Promise) {
      return result.then(async () => fetchMany(executor as never, this.#parent.sql, this.#parent.params, this.#relations) as unknown as RelationsResult<T, R>[]);
    }
    return fetchMany(executor as never, this.#parent.sql, this.#parent.params, this.#relations) as unknown as RelationsResult<T, R>[];
  }

  get(): RelationsResult<T, R> | null | Promise<RelationsResult<T, R> | null> {
    const executor = this.#parent._executor;
    const result = executor.executeSQL(this.#parent.sql, this.#parent.params);
    if (result instanceof Promise) {
      return result.then(async () => fetchOne(executor as never, this.#parent.sql, this.#parent.params, this.#relations) as unknown as RelationsResult<T, R> | null);
    }
    return fetchOne(executor as never, this.#parent.sql, this.#parent.params, this.#relations) as unknown as RelationsResult<T, R> | null;
  }
}

export function sql(strings: TemplateStringsArray, ...values: unknown[]): SqlQuery {
  const { sql: sqlStr, params } = buildSQL(strings, values);
  return new SqlQuery(sqlStr, params);
}

export { parseSQL, ParseError };
export type { };
