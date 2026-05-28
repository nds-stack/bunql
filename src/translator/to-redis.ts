/**
 * @module to-redis
 * @description Universal AST → Redis RESP command translator.
 */
import type { ASTNode } from "../ast/ast.ts";

export interface RedisCommand {
  command: string;
  args: (string | number)[];
}

export function astToRedis(node: ASTNode): RedisCommand {
  switch (node.type) {
    case "select": return translateSelect(node);
    case "insert": return translateInsert(node);
    case "update": return translateUpdate(node);
    case "delete": return translateDelete(node);
    case "aggregate": return { command: "PING", args: [] };
    case "raw": throw new Error("Raw SQL not supported for Redis translator");
    default: throw new Error(`Unsupported AST node for Redis: ${(node as ASTNode).type}`);
  }
}

function translateSelect(n: import("../ast/ast.ts").SelectNode): RedisCommand {
  const table = typeof n.from === "string" ? n.from : n.from.name;

  if (n.where && n.where.type === "eq" && n.where.left.name === "id") {
    return { command: "HGETALL", args: [`${table}:${String(n.where.right)}`] };
  }

  if (n.where && n.where.type === "in" && n.where.left.name === "id") {
    const ids = n.where.values.map(String);
    if (ids.length === 1) return { command: "HGETALL", args: [`${table}:${ids[0]}`] };
    const pipeline = ids.flatMap((id) => ["HGETALL", `${table}:${id}`]);
    return { command: "PIPELINE", args: pipeline };
  }

  if (n.orderBy && n.limit) {
    const key = n.orderBy[0]!.column.name ?? "score";
    const start = n.offset ?? 0;
    const stop = start + n.limit - 1;
    const rev = n.orderBy[0]!.direction === "desc";
    return { command: rev ? "ZREVRANGE" : "ZRANGE", args: [`${table}:${key}`, String(start), String(stop), "WITHSCORES"] };
  }

  return { command: "KEYS", args: [`${table}:*`] };
}

function translateInsert(n: import("../ast/ast.ts").InsertNode): RedisCommand {
  const table = n.table;
  const first = n.values[0];
  if (!first) return { command: "PING", args: [] };
  const cols = n.columns ?? [];

  if (cols.length >= 2 && cols.includes("id")) {
    const idIdx = cols.indexOf("id");
    const id = String(first[idIdx]!);
    const fields: (string | number)[] = [];
    for (const [i, col] of cols.entries()) {
      if (col !== "id") fields.push(col, first[i]! as string | number);
    }
    if (fields.length > 0) return { command: "HSET", args: [`${table}:${id}`, ...fields] };
  }

  if (cols.length === 2 && first.length === 2) {
    return { command: "SET", args: [`${table}:${String(first[0])}`, String(first[1])] };
  }

  if (first.length >= 2 && typeof first[1] === "number") {
    return { command: "ZADD", args: [`${table}:score`, String(first[1]), String(first[0])] };
  }

  if (first.length >= 1) {
    if (cols.length === 0 && first.length >= 2) {
      return { command: "SET", args: [`${table}:${String(first[0])}`, String(first[1])] };
    }
    const fields: (string | number)[] = [];
    for (let i = 0; i < cols.length && i < first.length; i++) {
      fields.push(cols[i]!, first[i]! as string | number);
    }
    return { command: "HSET", args: [`${table}:0`, ...fields] };
  }

  return { command: "PING", args: [] };
}

function translateUpdate(n: import("../ast/ast.ts").UpdateNode): RedisCommand {
  const table = n.table;
  const entries = Object.entries(n.set);

  if (n.where && n.where.type === "eq") {
    const id = String(n.where.right);
    const key = `${table}:${id}`;

    if (entries.length === 1) {
      const [k, v] = entries[0]!;
      return { command: "HSET", args: [key, k, String(v)] };
    }

    const fields: (string | number)[] = [];
    for (const [k, v] of entries) fields.push(k, v as string | number);
    return { command: "HSET", args: [key, ...fields] };
  }

  return { command: "PING", args: [] };
}

function translateDelete(n: import("../ast/ast.ts").DeleteNode): RedisCommand {
  const table = n.table;

  if (n.where && n.where.type === "eq") {
    return { command: "DEL", args: [`${table}:${String(n.where.right)}`] };
  }

  if (n.where && n.where.type === "in") {
    const keys = n.where.values.map((id) => `${table}:${String(id)}`);
    return { command: "DEL", args: keys as string[] };
  }

  return { command: "DEL", args: [`${table}:*`] };
}
