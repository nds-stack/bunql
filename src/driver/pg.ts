/**
 * @module driver/pg
 * @description PGDriver — PostgreSQL driver via custom TCP + wire protocol, zero deps.
 */

import type { DriverAdapter, QueryResult, RunResult } from "./adapter.ts";
import { PGConnectionPool, type PGConnectionConfig, PGError } from "./pg/connection.ts";

export interface PGDriverOptions {
  hostname?: string;
  port?: number;
  db?: string;
  user?: string;
  password?: string;
  maxPoolSize?: number;
}

function parsePGURL(url: string): PGDriverOptions {
  const parsed = new URL(url);
  const opts: PGDriverOptions = {
    hostname: parsed.hostname || "localhost",
    port: parseInt(parsed.port, 10) || 5432,
    db: parsed.pathname.replace(/^\//, "") || "postgres",
    user: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
  };

  const maxPool = parsed.searchParams.get("maxPoolSize");
  if (maxPool) opts.maxPoolSize = parseInt(maxPool, 10);

  return opts;
}

export class PGDriver implements DriverAdapter {
  readonly #pool: PGConnectionPool;
  readonly #db: string;

  constructor(options: PGDriverOptions | string) {
    const opts = typeof options === "string" ? parsePGURL(options) : options;
    const config: PGConnectionConfig = {
      hostname: opts.hostname ?? "localhost",
      port: opts.port ?? 5432,
      db: opts.db ?? "postgres",
      user: opts.user ?? "postgres",
      password: opts.password,
      maxPoolSize: opts.maxPoolSize ?? 5,
    };
    this.#db = config.db;
    this.#pool = new PGConnectionPool(config);
  }

  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    const conn = await this.#pool.acquire();
    try {
      let sqlStr = sql;
      if (params && params.length > 0) {
        sqlStr = interpolateParams(sql, params);
      }
      const result = await conn.query(sqlStr);
      return {
        columns: result.columns,
        rows: result.rows,
        duration: 0,
      };
    } finally {
      this.#pool.release(conn);
    }
  }

  async run(sql: string, params?: unknown[]): Promise<RunResult> {
    const conn = await this.#pool.acquire();
    try {
      let sqlStr = sql;
      if (params && params.length > 0) {
        sqlStr = interpolateParams(sql, params);
      }
      const result = await conn.query(sqlStr);
      const match = result.commandTag.match(/^(\w+)\s+(\d+)/);
      const changes = match ? parseInt(match[2]!, 10) : 0;
      return { changes, lastInsertRowid: 0 };
    } finally {
      this.#pool.release(conn);
    }
  }

  async close(): Promise<void> {
    await this.#pool.closeAll();
  }
}

function interpolateParams(sql: string, params: unknown[]): string {
  let idx = 0;
  return sql.replace(/\?/g, () => {
    const param = params[idx++];
    if (param === null || param === undefined) return "NULL";
    if (typeof param === "number") return String(param);
    if (typeof param === "boolean") return param ? "TRUE" : "FALSE";
    if (typeof param === "string") return `'${param.replace(/'/g, "''")}'`;
    return String(param);
  });
}

export type { };
