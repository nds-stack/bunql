/**
 * @module driver/mongodb
 * @description MongoDriver — implements DriverAdapter via custom TCP + BSON, zero deps.
 */

import type { DriverAdapter, QueryResult, RunResult } from "./adapter.ts";
import { type MongoConnectionConfig } from "./mongodb/connection.ts";
import { ConnectionPool } from "./mongodb/pool.ts";
import type { MongoCommand } from "../translator/to-mongodb.ts";
import { astToMongo } from "../translator/to-mongodb.ts";
import { parseSQL } from "../parser/sql-parser.ts";

export interface MongoDriverOptions {
  hostname?: string;
  port?: number;
  username?: string;
  password?: string;
  db?: string;
  authDb?: string;
  maxPoolSize?: number;
}

function parseMongoURL(url: string): MongoDriverOptions {
  const parsed = new URL(url);
  const opts: MongoDriverOptions = {
    hostname: parsed.hostname || "localhost",
    port: parseInt(parsed.port, 10) || 27017,
    db: parsed.pathname.replace(/^\//, "") || "test",
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
  };

  const authSource = parsed.searchParams.get("authSource");
  if (authSource) opts.authDb = authSource;

  const maxPool = parsed.searchParams.get("maxPoolSize");
  if (maxPool) opts.maxPoolSize = parseInt(maxPool, 10);

  return opts;
}

export class MongoDriver implements DriverAdapter {
  readonly #pool: ConnectionPool;
  readonly #db: string;

  constructor(options: MongoDriverOptions | string) {
    const opts = typeof options === "string" ? parseMongoURL(options) : options;
    const config: MongoConnectionConfig = {
      hostname: opts.hostname ?? "localhost",
      port: opts.port ?? 27017,
      db: opts.db ?? "test",
      username: opts.username,
      password: opts.password,
      authDb: opts.authDb,
      maxPoolSize: opts.maxPoolSize ?? 5,
    };
    this.#db = config.db;
    this.#pool = new ConnectionPool(config);
  }

  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    const node = parseSQL(sql);
    const command = astToMongo(node);
    const result = await this.#executeCommand(command);
    return this.#toQueryResult(result, command);
  }

  async run(sql: string, params?: unknown[]): Promise<RunResult> {
    const node = parseSQL(sql);
    const command = astToMongo(node);
    const result = await this.#executeCommand(command);
    return this.#toRunResult(result);
  }

  async close(): Promise<void> {
    await this.#pool.closeAll();
  }

  async #executeCommand(command: MongoCommand): Promise<Record<string, unknown>> {
    const conn = await this.#pool.acquire();
    try {
      const mongoCmd = this.#buildCommand(command);
      return await conn.execute(this.#db, mongoCmd);
    } finally {
      this.#pool.release(conn);
    }
  }

  #buildCommand(command: MongoCommand): Record<string, unknown> {
    const { collection, method, args } = command;

    switch (method) {
      case "find": {
        const cmd: Record<string, unknown> = { find: collection };
        if (args[0] !== undefined) cmd.filter = args[0];
        const opts = args[1] as Record<string, unknown> | undefined;
        if (opts) {
          if (opts.projection) cmd.projection = opts.projection;
          if (opts.sort) cmd.sort = opts.sort;
          if (opts.limit !== undefined) cmd.limit = opts.limit;
          if (opts.skip !== undefined) cmd.skip = opts.skip;
        }
        return cmd;
      }
      case "insertOne": {
        const doc = args[0] as Record<string, unknown>;
        return { insert: collection, documents: [doc], ordered: true };
      }
      case "insertMany": {
        const docs = args[0] as Record<string, unknown>[];
        return { insert: collection, documents: docs, ordered: true };
      }
      case "updateOne":
      case "updateMany": {
        const filter = args[0] as Record<string, unknown>;
        const update = args[1] as Record<string, unknown>;
        return { update: collection, updates: [{ q: filter, u: update }], ordered: true };
      }
      case "deleteOne": {
        const filter = args[0] as Record<string, unknown>;
        return { delete: collection, deletes: [{ q: filter, limit: 1 }], ordered: true };
      }
      case "deleteMany": {
        const filter = args[0] as Record<string, unknown>;
        return { delete: collection, deletes: [{ q: filter, limit: 0 }], ordered: true };
      }
      case "aggregate": {
        const pipeline = args[0] as Record<string, unknown>[];
        return { aggregate: collection, pipeline, cursor: {} };
      }
      default:
        throw new Error(`Unsupported MongoDB method: ${method}`);
    }
  }

  #toQueryResult(response: Record<string, unknown>, command: MongoCommand): QueryResult {
    const documents: Record<string, unknown>[] = [];

    if (response.cursor) {
      const cursor = response.cursor as Record<string, unknown>;
      const firstBatch = cursor.firstBatch as Record<string, unknown>[] | undefined;
      const nextBatch = cursor.nextBatch as Record<string, unknown>[] | undefined;
      if (firstBatch) documents.push(...firstBatch);
      if (nextBatch) documents.push(...nextBatch);
    }

    const columns = new Set<string>();
    for (const doc of documents) {
      for (const key of Object.keys(doc)) {
        columns.add(key);
      }
    }

    return {
      columns: Array.from(columns),
      rows: documents,
      duration: 0,
    };
  }

  #toRunResult(response: Record<string, unknown>): RunResult {
    const changes = (response.n as number) ?? 0;
    const insertId = response.insertedId;
    let lastInsertRowid: number | bigint = 0;

    if (insertId !== undefined && insertId !== null) {
      if (typeof insertId === "number") {
        lastInsertRowid = insertId;
      } else if (insertId instanceof Uint8Array) {
        const hex = Array.from(insertId).map((b) => b.toString(16).padStart(2, "0")).join("");
        lastInsertRowid = BigInt(`0x${hex}`);
      }
    }

    return { changes, lastInsertRowid };
  }
}
