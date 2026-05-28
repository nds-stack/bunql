/**
 * @module driver/redis
 * @description RedisDriver — implements DriverAdapter via custom TCP + RESP, zero deps.
 */

import type { DriverAdapter, QueryResult, RunResult } from "./adapter.ts";
import { RedisConnectionPool, type RedisConnectionConfig, RedisError } from "./redis/connection.ts";
import type { RESPValue } from "./redis/resp.ts";
import { astToRedis } from "../translator/to-redis.ts";
import { parseSQL } from "../parser/sql-parser.ts";

export interface RedisDriverOptions {
  hostname?: string;
  port?: number;
  db?: number;
  username?: string;
  password?: string;
  maxPoolSize?: number;
}

function parseRedisURL(url: string): RedisDriverOptions {
  const parsed = new URL(url);
  const opts: RedisDriverOptions = {
    hostname: parsed.hostname || "localhost",
    port: parseInt(parsed.port, 10) || 6379,
    db: parsed.pathname.replace(/^\//, "") ? parseInt(parsed.pathname.replace(/^\//, ""), 10) : undefined,
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
  };

  const maxPool = parsed.searchParams.get("maxPoolSize");
  if (maxPool) opts.maxPoolSize = parseInt(maxPool, 10);

  return opts;
}

export class RedisDriver implements DriverAdapter {
  readonly #pool: RedisConnectionPool;

  constructor(options: RedisDriverOptions | string) {
    const opts = typeof options === "string" ? parseRedisURL(options) : options;
    const config: RedisConnectionConfig = {
      hostname: opts.hostname ?? "localhost",
      port: opts.port ?? 6379,
      db: opts.db,
      username: opts.username,
      password: opts.password,
      maxPoolSize: opts.maxPoolSize ?? 10,
    };
    this.#pool = new RedisConnectionPool(config);
  }

  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    const node = parseSQL(sql);
    const cmd = astToRedis(node);

    if (cmd.command === "PIPELINE") {
      return this.#executePipeline(cmd.args as string[]);
    }

    const conn = await this.#pool.acquire();
    try {
      const resp = await conn.sendCommand([cmd.command, ...cmd.args.map(String)]);
      return this.#respToQueryResult(resp, cmd.command);
    } finally {
      this.#pool.release(conn);
    }
  }

  async run(sql: string, params?: unknown[]): Promise<RunResult> {
    const node = parseSQL(sql);
    const cmd = astToRedis(node);

    const conn = await this.#pool.acquire();
    try {
      const resp = await conn.sendCommand([cmd.command, ...cmd.args.map(String)]);
      return this.#respToRunResult(resp, cmd.command);
    } finally {
      this.#pool.release(conn);
    }
  }

  async close(): Promise<void> {
    await this.#pool.closeAll();
  }

  async #executePipeline(commands: string[]): Promise<QueryResult> {
    const conn = await this.#pool.acquire();
    try {
      const docs: Record<string, unknown>[] = [];
      for (let i = 0; i < commands.length; i += 2) {
        const cmd = commands[i]!;
        const key = commands[i + 1]!;
        const resp = await conn.sendCommand([cmd, key]);
        if (resp.type === "array" && resp.value) {
          const doc = arrayToRecord(resp.value);
          docs.push(doc);
        }
      }
      const columns = new Set<string>();
      for (const doc of docs) {
        for (const k of Object.keys(doc)) columns.add(k);
      }
      return { columns: Array.from(columns), rows: docs, duration: 0 };
    } finally {
      this.#pool.release(conn);
    }
  }

  #respToQueryResult(resp: RESPValue, command: string): QueryResult {
    switch (command) {
      case "HGETALL": {
        if (resp.type === "array" && resp.value) {
          const doc = arrayToRecord(resp.value);
          const columns = Object.keys(doc);
          return { columns, rows: [doc], duration: 0 };
        }
        return { columns: [], rows: [], duration: 0 };
      }

      case "SCAN": {
        if (resp.type === "array" && resp.value && resp.value.length >= 2) {
          const keysArr = resp.value[1];
          if (keysArr && keysArr.type === "array" && keysArr.value) {
            const docs: Record<string, unknown>[] = [];
            for (const item of keysArr.value) {
              if (item.type === "bulk-string" && item.value) {
                docs.push({ key: item.value });
              }
            }
            return { columns: ["key"], rows: docs, duration: 0 };
          }
        }
        return { columns: [], rows: [], duration: 0 };
      }

      case "ZRANGE":
      case "ZREVRANGE": {
        if (resp.type === "array" && resp.value) {
          const docs: Record<string, unknown>[] = [];
          for (let i = 0; i < resp.value.length; i += 2) {
            const member = resp.value[i];
            const score = resp.value[i + 1];
            if (member?.type === "bulk-string" && member.value) {
              docs.push({
                member: member.value,
                score: score?.type === "bulk-string" && score.value ? parseFloat(score.value) : null,
              });
            }
          }
          return { columns: ["member", "score"], rows: docs, duration: 0 };
        }
        return { columns: [], rows: [], duration: 0 };
      }

      case "KEYS": {
        if (resp.type === "array" && resp.value) {
          const docs: Record<string, unknown>[] = [];
          for (const item of resp.value) {
            if (item.type === "bulk-string" && item.value) {
              docs.push({ key: item.value });
            }
          }
          return { columns: ["key"], rows: docs, duration: 0 };
        }
        return { columns: [], rows: [], duration: 0 };
      }

      case "GET":
      case "PING":
      default: {
        if (resp.type === "bulk-string" && resp.value !== null) {
          return { columns: ["value"], rows: [{ value: resp.value }], duration: 0 };
        }
        return { columns: [], rows: [], duration: 0 };
      }
    }
  }

  #respToRunResult(resp: RESPValue, command: string): RunResult {
    switch (command) {
      case "HSET":
      case "SET":
      case "DEL":
      case "ZADD": {
        if (resp.type === "integer") {
          return { changes: resp.value, lastInsertRowid: resp.value };
        }
        if (resp.type === "simple-string") {
          return { changes: 1, lastInsertRowid: 0 };
        }
        return { changes: 0, lastInsertRowid: 0 };
      }

      default:
        return { changes: 0, lastInsertRowid: 0 };
    }
  }
}

function arrayToRecord(arr: RESPValue[]): Record<string, unknown> {
  const doc: Record<string, unknown> = {};
  for (let i = 0; i < arr.length; i += 2) {
    const key = arr[i];
    const val = arr[i + 1];
    if (key?.type === "bulk-string" && key.value !== null) {
      const v = val?.type === "bulk-string" ? val.value : val?.type === "integer" ? val.value : null;
      doc[key.value] = v;
    }
  }
  return doc;
}
