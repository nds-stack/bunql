/**
 * @module fts5
 * @description FTS5 full-text search helper — create, search, insert, delete, update, rebuild, merge, optimize, drop, rank.
 */
import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { FTS5Options } from "./types/options.ts";
import type { FTSResult } from "./types/result.ts";

export class FTS5Helper {
  #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async create(table: string, columns: string[], options?: FTS5Options): Promise<void> {
    const cols = columns.map((c) => c.includes("(") ? c : `"${c}"`).join(", ");
    let extra = "";
    if (options?.tokenize) extra += `, tokenize='${options.tokenize.replace(/'/g, "''")}'`;
    if (options?.content) extra += `, content='${options.content.replace(/'/g, "''")}'`;
    if (options?.prefix && options.prefix.length > 0) {
      extra += `, prefix=${JSON.stringify(options.prefix)}`;
    }
    this.#db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS "${table}" USING fts5(${cols}${extra})`);
  }

  async drop(table: string): Promise<void> {
    this.#db.exec(`DROP TABLE IF EXISTS "${table}"`);
  }

  async insert(table: string, data: Record<string, unknown>): Promise<void> {
    const keys = Object.keys(data);
    const cols = keys.map((k) => `"${k}"`).join(", ");
    const placeholders = keys.map(() => "?").join(", ");
    const values = keys.map((k) => data[k] as SQLQueryBindings);
    this.#db.prepare(`INSERT INTO "${table}"(${cols}) VALUES(${placeholders})`).run(...values);
  }

  async delete(table: string, id: number | string): Promise<void> {
    this.#db.prepare(`DELETE FROM "${table}" WHERE rowid = ?`).run(id);
  }

  async update(table: string, id: number | string, data: Record<string, unknown>): Promise<void> {
    const keys = Object.keys(data);
    const cols = keys.map((k) => `"${k}"`).join(", ");
    const placeholders = keys.map(() => "?").join(", ");
    const values = keys.map((k) => data[k] as SQLQueryBindings);
    this.#db.prepare(`INSERT OR REPLACE INTO "${table}"(rowid, ${cols}) VALUES(?, ${placeholders})`).run(id, ...values);
  }

  search<T = FTSResult>(
    table: string,
    query: string,
    options?: {
      limit?: number;
      offset?: number;
      columns?: string[];
      snippet?: boolean | { startTag?: string; endTag?: string; maxTokens?: number };
      highlight?: boolean;
      orderBy?: string;
    },
  ): T[] {
    const colSel = options?.columns
      ? options.columns.map((c) => `"${c}"`).join(", ")
      : "*";
    let extras = "";
    if (options?.snippet) {
      const start = typeof options.snippet === "object" ? options.snippet.startTag ?? "<b>" : "<b>";
      const end = typeof options.snippet === "object" ? options.snippet.endTag ?? "</b>" : "</b>";
      const max = typeof options.snippet === "object" ? options.snippet.maxTokens ?? 64 : 64;
      extras = `, snippet("${table}", 0, '${start}', '${end}', '...', ${max}) AS snippet`;
    }
    if (options?.highlight) {
      extras += `, highlight("${table}", 0, '<b>', '</b>') AS highlight`;
    }
    const order = options?.orderBy ?? "rank";
    const limit = options?.limit ?? 20;
    const offset = options?.offset ?? 0;

    const sql = `SELECT rowid, ${colSel}${extras}, rank FROM "${table}" WHERE "${table}" MATCH ? ORDER BY ${order} LIMIT ? OFFSET ?`;
    return this.#db.prepare(sql).all(query, limit, offset) as T[];
  }

  async rebuild(table: string): Promise<void> {
    this.#db.exec(`INSERT INTO "${table}"("${table}") VALUES('rebuild')`);
  }

  async merge(table: string, blocks = 16): Promise<void> {
    this.#db.exec(`INSERT INTO "${table}"("${table}") VALUES('merge=${blocks}')`);
  }

  async optimize(table: string): Promise<void> {
    this.#db.exec(`INSERT INTO "${table}"("${table}") VALUES('optimize')`);
  }

  async integrityCheck(table: string): Promise<boolean> {
    try {
      this.#db.exec(`INSERT INTO "${table}"("${table}") VALUES('integrity-check')`);
      return true;
    } catch {
      return false;
    }
  }

  rank(table: string, query: string, id: number): number {
    const row = this.#db
      .prepare(`SELECT rank FROM "${table}" WHERE "${table}" MATCH ? AND rowid = ?`)
      .get(query, id) as { rank: number } | undefined;
    return row?.rank ?? 0;
  }
}
