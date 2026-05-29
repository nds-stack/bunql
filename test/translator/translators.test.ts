/**
 * @module test-translators
 * @description Tests for AST → SQL / MongoDB / Redis translators.
 */
import { describe, test, expect } from "bun:test";
import { parseSQL } from "../../src/parser/sql-parser.ts";
import { parseMQL } from "../../src/parser/mql-parser.ts";
import { astToSQL } from "../../src/translator/to-sql.ts";
import { astToMongo } from "../../src/translator/to-mongodb.ts";
import { astToRedis } from "../../src/translator/to-redis.ts";
import { col, table, eq, and, orderBy } from "../../src/ast/ast.ts";
import type { SelectNode } from "../../src/ast/ast.ts";

describe("AST → SQLite", () => {
  test("SELECT translation", () => {
    const result = astToSQL({ type: "select", columns: [col("id"), col("name")], from: table("users") });
    expect(result.sql).toBe("SELECT id, name FROM users");
    expect(result.params).toEqual([]);
  });

  test("SELECT with WHERE eq", () => {
    const result = astToSQL({
      type: "select", columns: [{ type: "wildcard" }], from: table("users"),
      where: eq(col("id"), 1),
    });
    expect(result.sql).toBe("SELECT * FROM users WHERE id = ?");
    expect(result.params).toEqual([1]);
  });

  test("SELECT with WHERE AND", () => {
    const result = astToSQL({
      type: "select", columns: [{ type: "wildcard" }], from: table("users"),
      where: and(eq(col("age"), 25), eq(col("active"), true)),
    });
    expect(result.sql).toContain("WHERE");
    expect(result.sql).toContain("AND");
    expect(result.params).toEqual([25, true]);
  });

  test("INSERT translation", () => {
    const result = astToSQL({
      type: "insert", table: "users", columns: ["name", "email"],
      values: [["Alice", "a@t.com"]],
    });
    expect(result.sql).toBe("INSERT INTO users (name, email) VALUES (?, ?)");
    expect(result.params).toEqual(["Alice", "a@t.com"]);
  });

  test("UPDATE translation", () => {
    const result = astToSQL({
      type: "update", table: "users",
      set: { name: "Bob" },
      where: eq(col("id"), 1),
    });
    expect(result.sql).toBe("UPDATE users SET name = ? WHERE id = ?");
    expect(result.params).toEqual(["Bob", 1]);
  });

  test("DELETE translation", () => {
    const result = astToSQL({
      type: "delete", table: "users",
      where: eq(col("id"), 1),
    });
    expect(result.sql).toBe("DELETE FROM users WHERE id = ?");
  });

  test("ORDER BY + LIMIT translation", () => {
    const result = astToSQL({
      type: "select", columns: [{ type: "wildcard" }], from: table("users"),
      orderBy: [orderBy(col("name"), "desc")], limit: 10, offset: 5,
    });
    expect(result.sql).toContain("ORDER BY name DESC");
    expect(result.sql).toContain("LIMIT 10");
    expect(result.sql).toContain("OFFSET 5");
  });
});

describe("SQL → AST → SQL (round-trip)", () => {
  test("SELECT round-trip", () => {
    const sql = "SELECT id, name FROM users WHERE age > 25 ORDER BY name ASC LIMIT 10";
    const ast = parseSQL(sql) as SelectNode;
    const result = astToSQL(ast);
    expect(result.sql.toLowerCase()).toContain("select");
    expect(result.sql).toContain("users");
    expect(result.params).toEqual([25]);
  });
});

describe("AST → MongoDB", () => {
  test("SELECT → find translation", () => {
    const cmd = astToMongo({
      type: "select", columns: [col("name")], from: table("users"),
      where: eq(col("age"), 25),
    });
    expect(cmd.method).toBe("find");
    expect(cmd.collection).toBe("users");
    const filter = cmd.args[0] as Record<string, unknown>;
    expect(filter.age).toBe(25);
  });

  test("SELECT with ORDER BY → sort", () => {
    const cmd = astToMongo({
      type: "select", columns: [{ type: "wildcard" }], from: table("users"),
      orderBy: [orderBy(col("name"), "desc")], limit: 10,
    });
    expect(cmd.method).toBe("find");
    const options = cmd.args[1] as Record<string, unknown>;
    expect(options.sort).toEqual({ name: -1 });
    expect(options.limit).toBe(10);
  });

  test("INSERT → insertOne", () => {
    const cmd = astToMongo({
      type: "insert", table: "users", columns: ["name", "email"],
      values: [["Alice", "a@t.com"]],
    });
    expect(cmd.method).toBe("insertOne");
    expect(cmd.args[0]).toEqual({ name: "Alice", email: "a@t.com" });
  });

  test("DELETE → deleteMany", () => {
    const cmd = astToMongo({
      type: "delete", table: "users", where: eq(col("id"), 1),
    });
    expect(cmd.method).toBe("deleteMany");
  });
});

describe("SQL → AST → MongoDB (round-trip)", () => {
  test("SQL SELECT → MQL command", () => {
    const sql = "SELECT name FROM users WHERE age > 25 LIMIT 10";
    const ast = parseSQL(sql);
    const cmd = astToMongo(ast);
    expect(cmd.collection).toBe("users");
    expect(cmd.method).toBe("find");
  });

  test("SQL INSERT → MQL command", () => {
    const sql = "INSERT INTO users (name) VALUES ('Alice')";
    const ast = parseSQL(sql);
    const cmd = astToMongo(ast);
    expect(cmd.method).toBe("insertOne");
  });
});

describe("MQL → AST → SQL (round-trip)", () => {
  test("MQL find → AST → SQL", () => {
    const ast = parseMQL("users", "find", [{ age: { $gt: 25 } }]);
    const result = astToSQL(ast);
    expect(result.sql.toLowerCase()).toContain("select");
    expect(result.sql).toContain("users");
    expect(result.params).toEqual([25]);
  });

  test("MQL aggregate → AST → SQL group by", () => {
    const ast = parseMQL("orders", "aggregate", [[{
      $group: { _id: "$status", count: { $count: {} } },
    }]]);
    expect(ast.type).toBe("aggregate");
  });
});

describe("AST → Redis", () => {
  test("SELECT by id → HGETALL", () => {
    const cmd = astToRedis({
      type: "select", columns: [{ type: "wildcard" }], from: table("users"),
      where: eq(col("id"), 1),
    });
    expect(cmd.command).toBe("HGETALL");
    expect(cmd.args).toEqual(["users:1"]);
  });

  test("INSERT → HSET", () => {
    const cmd = astToRedis({
      type: "insert", table: "users", columns: ["id", "name", "email"],
      values: [[1, "Alice", "a@t.com"]],
    });
    expect(cmd.command).toBe("HSET");
    expect(cmd.args[0]).toBe("users:1");
  });

  test("DELETE → DEL", () => {
    const cmd = astToRedis({
      type: "delete", table: "users", where: eq(col("id"), 1),
    });
    expect(cmd.command).toBe("DEL");
    expect(cmd.args).toEqual(["users:1"]);
  });
});
