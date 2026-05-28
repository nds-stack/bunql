/**
 * @module driver/mysql
 * @description MySQLDriver — MySQL driver via custom TCP + wire protocol, zero deps.
 */

import type { DriverAdapter, QueryResult, RunResult } from "./adapter.ts";
import { type MySQLConnectionConfig } from "./mysql/connection.ts";
import { MySQLConnectionPool } from "./mysql/pool.ts";
import { MySQLError } from "./mysql/error.ts";
import { type ResultSetPacket, type ResponsePacket } from "./mysql/wire.ts";

const textEncoder = new TextEncoder();

export interface MySQLDriverOptions {
  hostname?: string;
  port?: number;
  db?: string;
  user?: string;
  password?: string;
  maxPoolSize?: number;
}

function parseMySQLURL(url: string): MySQLDriverOptions {
  const parsed = new URL(url);
  const opts: MySQLDriverOptions = {
    hostname: parsed.hostname || "localhost",
    port: parseInt(parsed.port, 10) || 3306,
    db: parsed.pathname.replace(/^\//, "") || "mysql",
    user: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
  };
  const maxPool = parsed.searchParams.get("maxPoolSize");
  if (maxPool) opts.maxPoolSize = parseInt(maxPool, 10);
  return opts;
}

export class MySQLDriver implements DriverAdapter {
  readonly #pool: MySQLConnectionPool;

  constructor(options: MySQLDriverOptions | string) {
    const opts = typeof options === "string" ? parseMySQLURL(options) : options;
    const config: MySQLConnectionConfig = {
      hostname: opts.hostname ?? "localhost",
      port: opts.port ?? 3306,
      db: opts.db ?? "mysql",
      user: opts.user ?? "root",
      password: opts.password,
      maxPoolSize: opts.maxPoolSize ?? 5,
    };
    this.#pool = new MySQLConnectionPool(config);
  }

  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    const conn = await this.#pool.acquire();
    try {
      let result: ResponsePacket;
      if (params && params.length > 0) {
        const stmtInfo = await conn.prepare(sql);
        const paramBytes: (Uint8Array | null)[] = params.map((p) => {
          if (p === null || p === undefined) return null;
          return textEncoder.encode(String(p));
        });
        result = await conn.executePrepared(stmtInfo.statementId, paramBytes);
        conn.closeStmt(stmtInfo.statementId);
      } else {
        result = await conn.query(sql);
      }
      if (result.type === "error") throw new MySQLError(result.message, result.code);
      if (result.type === "ok") return { columns: [], rows: [], duration: 0 };
      const rs = result as ResultSetPacket;
      const rows = rs.rows.map((row) => {
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < rs.columns.length && i < row.length; i++) {
          obj[rs.columns[i]!.name] = row[i] === null ? null : new TextDecoder().decode(row[i]!);
        }
        return obj;
      });
      return { columns: rs.columns.map((c) => c.name), rows, duration: 0 };
    } finally {
      this.#pool.release(conn);
    }
  }

  async run(sql: string, params?: unknown[]): Promise<RunResult> {
    const conn = await this.#pool.acquire();
    try {
      let result: ResponsePacket;
      if (params && params.length > 0) {
        const stmtInfo = await conn.prepare(sql);
        const paramBytes: (Uint8Array | null)[] = params.map((p) => {
          if (p === null || p === undefined) return null;
          return textEncoder.encode(String(p));
        });
        result = await conn.executePrepared(stmtInfo.statementId, paramBytes);
        conn.closeStmt(stmtInfo.statementId);
      } else {
        result = await conn.query(sql);
      }
      if (result.type === "error") throw new MySQLError(result.message, result.code);
      if (result.type === "resultset") return { changes: result.rows.length, lastInsertRowid: 0 };
      return { changes: result.affectedRows, lastInsertRowid: result.lastInsertId };
    } finally {
      this.#pool.release(conn);
    }
  }

  async close(): Promise<void> { await this.#pool.closeAll(); }
}

export type { };
