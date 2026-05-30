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
    expect(result.sql).toContain("LIMIT ?");
    expect(result.sql).toContain("OFFSET ?");
    expect(result.params).toEqual([10, 5]);
  });
});

describe("SQL → AST → SQL (round-trip)", () => {
  test("SELECT round-trip", () => {
    const sql = "SELECT id, name FROM users WHERE age > 25 ORDER BY name ASC LIMIT 10";
    const ast = parseSQL(sql) as SelectNode;
    const result = astToSQL(ast);
    expect(result.sql.toLowerCase()).toContain("select");
    expect(result.sql).toContain("users");
    expect(result.params).toEqual([25, 10]);
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

  test("SQL LEFT JOIN → MQL $lookup", () => {
    const sql = "SELECT * FROM users LEFT JOIN orders ON users.id = orders.user_id";
    const ast = parseSQL(sql);
    const cmd = astToMongo(ast);
    expect(cmd.method).toBe("aggregate");
    const pipeline = cmd.args[0] as Record<string, unknown>[];
    const lookupStage = pipeline.find(s => (s as Record<string, unknown>).$lookup) as Record<string, unknown> | undefined;
    expect(lookupStage).toBeDefined();
    const lookup = lookupStage!.$lookup as Record<string, unknown>;
    expect(lookup.from).toBe("orders");
    expect(lookup.localField).toBe("id");
    expect(lookup.foreignField).toBe("user_id");
    expect(lookup._joinType).toBeUndefined(); // LEFT join doesn't set _joinType
  });

  test("SQL INNER JOIN → MQL $lookup with _joinType", () => {
    const sql = "SELECT * FROM users JOIN orders ON users.id = orders.user_id";
    const ast = parseSQL(sql);
    const cmd = astToMongo(ast);
    expect(cmd.method).toBe("aggregate");
    const pipeline = cmd.args[0] as Record<string, unknown>[];
    const lookupStage = pipeline.find(s => (s as Record<string, unknown>).$lookup) as Record<string, unknown> | undefined;
    expect(lookupStage).toBeDefined();
    const lookup = lookupStage!.$lookup as Record<string, unknown>;
    expect(lookup.from).toBe("orders");
    expect(lookup.localField).toBe("id");
    expect(lookup.foreignField).toBe("user_id");
    expect(lookup._joinType).toBe("inner");
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

  test("SELECT by ORDER BY + LIMIT → ZRANGE", () => {
    const cmd = astToRedis({
      type: "select", columns: [{ type: "wildcard" }], from: table("scores"),
      orderBy: [{ column: col("score"), direction: "desc" }], limit: 10,
    });
    expect(cmd.command).toBe("ZREVRANGE");
    expect(cmd.args).toContain("0");
    expect(cmd.args).toContain("9");
    expect(cmd.args).toContain("WITHSCORES");
  });

  test("SELECT fallback (no WHERE) → SCAN", () => {
    const cmd = astToRedis({
      type: "select", columns: [{ type: "wildcard" }], from: table("users"),
    });
    expect(cmd.command).toBe("SCAN");
    expect(cmd.args).toContain("users:*");
  });

  test("SELECT WHERE id IN (...) → PIPELINE", () => {
    const cmd = astToRedis({
      type: "select", columns: [{ type: "wildcard" }], from: table("users"),
      where: { type: "in", left: col("id"), values: [1, 2, 3] },
    });
    expect(cmd.command).toBe("PIPELINE");
  });
});

describe("MQL operators → SQL", () => {
  test("$mod → SQL modulo", () => {
    const ast = parseMQL("users", "find", [{ age: { $mod: [5, 2] } }]);
    if (ast.type !== "select") throw new Error(`Expected select, got ${ast.type}`);
    const result = astToSQL(ast);
    expect(result.sql).toContain("%");
    expect(result.sql).toContain("=");
  });

  test("$size → SQL json_array_length", () => {
    const ast = parseMQL("users", "find", [{ tags: { $size: 3 } }]);
    if (ast.type !== "select") throw new Error(`Expected select, got ${ast.type}`);
    const result = astToSQL(ast);
    expect(result.sql).toContain("json_array_length");
    expect(result.sql).toContain("=");
  });

  test("$type → SQL TYPEOF", () => {
    const ast = parseMQL("users", "find", [{ name: { $type: "string" } }]);
    if (ast.type !== "select") throw new Error(`Expected select, got ${ast.type}`);
    const result = astToSQL(ast);
    expect(result.sql).toContain("TYPEOF");
  });

  test("$all → SQL LIKE AND", () => {
    const ast = parseMQL("users", "find", [{ tags: { $all: ["a", "b"] } }]);
    if (ast.type !== "select") throw new Error(`Expected select, got ${ast.type}`);
    const result = astToSQL(ast);
    expect(result.sql).toContain("LIKE");
    expect(result.sql).toContain("AND");
  });

  test("$elemMatch → SQL EXISTS json_each", () => {
    const ast = parseMQL("users", "find", [{ arr: { $elemMatch: { x: 1 } } }]);
    if (ast.type !== "select") throw new Error(`Expected select, got ${ast.type}`);
    const result = astToSQL(ast);
    expect(result.sql).toContain("EXISTS");
    expect(result.sql).toContain("json_each");
  });

  test("$expr → SQL field comparison", () => {
    // $expr must use column references ($ prefix) within field-level operator
    const ast = parseMQL("users", "find", [{ $expr: { $gt: ["$balance", "$limit"] } }]);
    // Note: $expr at top-level is parsed as field "$expr" → mqlOperator gets $gt
    const result = astToSQL(ast);
    // The expression should contain column-style references
    expect(result.sql).toBeDefined();
  });

  test("$regex + $options → SQL LIKE", () => {
    const ast = parseMQL("users", "find", [{ name: { $regex: "^abc", $options: "i" } }]);
    if (ast.type !== "select") throw new Error(`Expected select, got ${ast.type}`);
    const result = astToSQL(ast);
    expect(result.sql).toContain("LIKE");
    // case-insensitive via LOWER()
    const lower = result.sql.match(/LOWER/gi);
    expect(lower).not.toBeNull();
  });

  test("$exists true → SQL IS NOT NULL", () => {
    const ast = parseMQL("users", "find", [{ email: { $exists: true } }]);
    if (ast.type !== "select") throw new Error(`Expected select, got ${ast.type}`);
    const result = astToSQL(ast);
    expect(result.sql).toContain("IS NOT NULL");
  });

  test("$exists false → SQL IS NULL", () => {
    const ast = parseMQL("users", "find", [{ email: { $exists: false } }]);
    if (ast.type !== "select") throw new Error(`Expected select, got ${ast.type}`);
    const result = astToSQL(ast);
    expect(result.sql).toContain("IS NULL");
  });

  test("$not → SQL NOT", () => {
    const ast = parseMQL("users", "find", [{ age: { $not: { $gt: 25 } } }]);
    if (ast.type !== "select") throw new Error(`Expected select, got ${ast.type}`);
    const result = astToSQL(ast);
    expect(result.sql).toContain("NOT");
  });

  test("$nor top-level → SQL NOT AND NOT", () => {
    const ast = parseMQL("users", "find", [{ $nor: [{ age: 10 }, { age: 20 }] }]);
    if (ast.type !== "select") throw new Error(`Expected select, got ${ast.type}`);
    const result = astToSQL(ast);
    expect(result.sql).toContain("NOT");
    expect(result.sql).toContain("AND");
    expect(result.params).toEqual([10, 20]);
  });

  test("$expr top-level → SQL column comparison", () => {
    const ast = parseMQL("users", "find", [{ $expr: { $gt: ["$balance", "$limit"] } }]);
    if (ast.type !== "select") throw new Error(`Expected select, got ${ast.type}`);
    const result = astToSQL(ast);
    expect(result.sql).toContain("balance");
    expect(result.sql).toContain("limit");
    expect(result.sql).toContain(">");
  });
});

describe("MQL update operators → SQL", () => {
  test("$inc → SET col = col + ?", () => {
    const ast = parseMQL("users", "updateOne", [{ id: 1 }, { $inc: { count: 1 } }]);
    if (ast.type !== "update") throw new Error(`Expected update, got ${ast.type}`);
    const result = astToSQL(ast);
    expect(result.sql).toContain("count = count + ?");
  });

  test("$unset → SET col = NULL", () => {
    const ast = parseMQL("users", "updateOne", [{ id: 1 }, { $unset: { temp: "" } }]);
    if (ast.type !== "update") throw new Error(`Expected update, got ${ast.type}`);
    const result = astToSQL(ast);
    expect(result.sql).toContain("temp = NULL");
  });

  test("$set → SET col = ?", () => {
    const ast = parseMQL("users", "updateOne", [{ id: 1 }, { $set: { name: "Bob" } }]);
    if (ast.type !== "update") throw new Error(`Expected update, got ${ast.type}`);
    const result = astToSQL(ast);
    expect(result.sql).toContain("name = ?");
  });

  test("$min update → SQL SET", () => {
    const ast = parseMQL("users", "updateOne", [{ id: 1 }, { $min: { price: 100 } }]);
    if (ast.type !== "update") throw new Error(`Expected update, got ${ast.type}`);
    const result = astToSQL(ast);
    expect(result.sql).toContain("price = ?");
  });

  test("$max update → SQL SET", () => {
    const ast = parseMQL("users", "updateOne", [{ id: 1 }, { $max: { price: 200 } }]);
    if (ast.type !== "update") throw new Error(`Expected update, got ${ast.type}`);
    const result = astToSQL(ast);
    expect(result.sql).toContain("price = ?");
  });

  test("$pop update → SQL SET", () => {
    const ast = parseMQL("users", "updateOne", [{ id: 1 }, { $pop: { tags: 1 } }]);
    if (ast.type !== "update") throw new Error(`Expected update, got ${ast.type}`);
    const result = astToSQL(ast);
    expect(result.sql).toContain("tags = ?");
  });

  test("$rename update → SQL SET new = old", () => {
    const ast = parseMQL("users", "updateOne", [{ id: 1 }, { $rename: { oldName: "newName" } }]);
    if (ast.type !== "update") throw new Error(`Expected update, got ${ast.type}`);
    const result = astToSQL(ast);
    expect(result.sql).toContain("newName = oldName");
  });

  test("$push update → SQL array append", () => {
    const ast = parseMQL("users", "updateOne", [{ id: 1 }, { $push: { tags: "new" } }]);
    if (ast.type !== "update") throw new Error(`Expected update, got ${ast.type}`);
    const result = astToSQL(ast);
    expect(result.sql).toContain("tags =");
  });

  test("$pull update → SQL SET", () => {
    const ast = parseMQL("users", "updateOne", [{ id: 1 }, { $pull: { tags: "old" } }]);
    if (ast.type !== "update") throw new Error(`Expected update, got ${ast.type}`);
    const result = astToSQL(ast);
    expect(result.sql).toContain("tags = ?");
  });
});

describe("MQL accumulators → SQL", () => {
  test("$avg in $group", () => {
    const ast = parseMQL("orders", "aggregate", [[{
      $group: { _id: "$status", avgAmount: { $avg: "$amount" } },
    }]]);
    expect(ast.type).toBe("aggregate");
    if (ast.type === "aggregate") {
      const result = astToSQL(ast);
      expect(result.sql).toContain("AVG(amount)");
    }
  });

  test("$min in $group", () => {
    const ast = parseMQL("orders", "aggregate", [[{
      $group: { _id: "$status", minAmount: { $min: "$amount" } },
    }]]);
    expect(ast.type).toBe("aggregate");
    if (ast.type === "aggregate") {
      const result = astToSQL(ast);
      expect(result.sql).toContain("MIN(amount)");
    }
  });

  test("$max in $group", () => {
    const ast = parseMQL("orders", "aggregate", [[{
      $group: { _id: "$status", maxAmount: { $max: "$amount" } },
    }]]);
    expect(ast.type).toBe("aggregate");
    if (ast.type === "aggregate") {
      const result = astToSQL(ast);
      expect(result.sql).toContain("MAX(amount)");
    }
  });

  test("$addToSet in $group", () => {
    const ast = parseMQL("orders", "aggregate", [[{
      $group: { _id: "$status", items: { $addToSet: "$name" } },
    }]]);
    expect(ast.type).toBe("aggregate");
    if (ast.type === "aggregate") {
      const result = astToSQL(ast);
      expect(result.sql).toContain("json_group_array(DISTINCT");
    }
  });

  test("$push in $group", () => {
    const ast = parseMQL("orders", "aggregate", [[{
      $group: { _id: "$status", items: { $push: "$name" } },
    }]]);
    expect(ast.type).toBe("aggregate");
    if (ast.type === "aggregate") {
      const result = astToSQL(ast);
      expect(result.sql).toContain("json_group_array(name)");
    }
  });

  test("$first in $group generates FIRST_VALUE window function", () => {
    const ast = parseMQL("orders", "aggregate", [[{
      $group: { _id: "$status", firstName: { $first: "$name" } },
    }]]);
    expect(ast.type).toBe("aggregate");
    if (ast.type === "aggregate") {
      const result = astToSQL(ast);
      expect(result.sql).toContain("FIRST_VALUE(name)");
    }
  });

  test("$last in $group generates LAST_VALUE window function", () => {
    const ast = parseMQL("orders", "aggregate", [[{
      $group: { _id: "$status", lastName: { $last: "$name" } },
    }]]);
    expect(ast.type).toBe("aggregate");
    if (ast.type === "aggregate") {
      const result = astToSQL(ast);
      expect(result.sql).toContain("LAST_VALUE(name)");
    }
  });
});

describe("SQL advanced → AST → SQL round-trip", () => {
  test("SELECT with HAVING", () => {
    const sql = "SELECT status, COUNT(*) FROM orders GROUP BY status HAVING COUNT(*) > 1";
    const ast = parseSQL(sql);
    const result = astToSQL(ast);
    expect(result.sql.toLowerCase()).toContain("having");
    expect(result.sql.toLowerCase()).toContain("group by");
  });

  test("SELECT with arithmetic expression", () => {
    const sql = "SELECT price * qty AS total FROM orders";
    const ast = parseSQL(sql);
    const result = astToSQL(ast);
    expect(result.sql.toLowerCase()).toContain("price");
    expect(result.sql.toLowerCase()).toContain("qty");
  });

  test("INSERT with RETURNING", () => {
    const sql = "INSERT INTO users (name) VALUES ('Alice') RETURNING id";
    const ast = parseSQL(sql);
    const result = astToSQL(ast);
    expect(result.sql.toUpperCase()).toContain("RETURNING");
    expect(result.sql).toContain("id");
  });

  test("INSERT...SELECT round-trip", () => {
    const sql = "INSERT INTO archive SELECT * FROM users WHERE active = 0";
    const ast = parseSQL(sql);
    const result = astToSQL(ast);
    expect(result.sql.toLowerCase()).toContain("insert");
    expect(result.sql.toLowerCase()).toContain("select");
    expect(result.sql.toLowerCase()).toContain("archive");
  });

  test("UPDATE with RETURNING", () => {
    const sql = "UPDATE users SET name = 'Bob' WHERE id = 1 RETURNING id, name";
    const ast = parseSQL(sql);
    const result = astToSQL(ast);
    expect(result.sql.toUpperCase()).toContain("RETURNING");
    expect(result.sql).toContain("id");
    expect(result.sql).toContain("name");
  });

  test("SELECT ORDER BY + LIMIT + OFFSET with params", () => {
    const sql = "SELECT * FROM users ORDER BY name ASC LIMIT ? OFFSET ?";
    const ast = parseSQL(sql);
    const result = astToSQL(ast, "postgresql");
    expect(result.sql).toContain("ORDER BY");
    expect(result.sql).toContain("LIMIT");
    expect(result.sql).toContain("OFFSET");
  });

  test("COUNT(DISTINCT col) round-trip", () => {
    const sql = "SELECT COUNT(DISTINCT status) FROM orders";
    const ast = parseSQL(sql);
    const result = astToSQL(ast);
    expect(result.sql.toUpperCase()).toContain("COUNT(DISTINCT");
  });

  test("SELECT with LEFT JOIN", () => {
    const sql = "SELECT * FROM users LEFT JOIN orders ON users.id = orders.user_id";
    const ast = parseSQL(sql);
    const result = astToSQL(ast);
    expect(result.sql.toUpperCase()).toContain("LEFT JOIN");
  });

  test("CTE WITH round-trip", () => {
    const ast = parseSQL("WITH cte AS (SELECT * FROM users) SELECT * FROM cte");
    if (ast.type === "select") {
      expect(ast.ctes).toBeDefined();
      const result = astToSQL(ast);
      expect(result.sql.toLowerCase()).toContain("with");
    }
  });

  test("UNION round-trip", () => {
    const ast = parseSQL("SELECT * FROM a UNION SELECT * FROM b");
    if (ast.type === "setOp") {
      const result = astToSQL(ast);
      expect(result.sql.toUpperCase()).toContain("UNION");
    }
  });
});

describe("MQL aggregate stages → SQL", () => {
  test("$lookup simple → LEFT JOIN", () => {
    const ast = parseMQL("orders", "aggregate", [[{
      $lookup: { from: "users", localField: "userId", foreignField: "id", as: "user" },
    }]]);
    expect(ast.type).toBe("aggregate");
    if (ast.type === "aggregate") {
      const result = astToSQL(ast);
      expect(result.sql.toUpperCase()).toContain("LEFT JOIN");
    }
  });

  test("$unwind → not supported for SQL", () => {
    const ast = parseMQL("orders", "aggregate", [[{
      $unwind: "$items",
    }]]);
    expect(ast.type).toBe("aggregate");
    if (ast.type === "aggregate") {
      const result = astToSQL(ast);
      expect(result.sql).toBeDefined();
    }
  });

  test("$sample → SQL ORDER BY RANDOM()", () => {
    const ast = parseMQL("users", "aggregate", [[{
      $sample: { size: 5 },
    }]]);
    expect(ast.type).toBe("aggregate");
    if (ast.type === "aggregate") {
      const result = astToSQL(ast);
      expect(result.sql).toContain("LIMIT");
    }
  });

  test("$addFields → SQL computed columns", () => {
    const ast = parseMQL("users", "aggregate", [[{
      $addFields: { fullName: { $concat: ["$first", " ", "$last"] } },
    }]]);
    expect(ast.type).toBe("aggregate");
    if (ast.type === "aggregate") {
      const result = astToSQL(ast);
      expect(result.sql).toContain("fullName");
      expect(result.sql).toContain("CONCAT");
    }
  });

  test("$set stage → SQL computed columns", () => {
    const ast = parseMQL("users", "aggregate", [[{
      $set: { total: { $add: ["$price", "$tax"] } },
    }]]);
    expect(ast.type).toBe("aggregate");
    if (ast.type === "aggregate") {
      const result = astToSQL(ast);
      expect(result.sql).toContain("total");
      expect(result.sql).toContain("+");
    }
  });
});

describe("MQL → MongoDB round-trip", () => {
  test("$lookup complex with pipeline", () => {
    const ast = parseMQL("orders", "aggregate", [[{
      $lookup: {
        from: "users",
        let: { uid: "$userId" },
        pipeline: [{ $match: { $expr: { $eq: ["$_id", "$$uid"] } } }],
        as: "user",
      },
    }]]);
    expect(ast.type).toBe("aggregate");
    if (ast.type === "aggregate") {
      const cmd = astToMongo(ast);
      expect(cmd.method).toBe("aggregate");
    }
  });

  test("$unwind → MongoDB aggregate", () => {
    const ast = parseMQL("users", "aggregate", [[{
      $unwind: { path: "$tags", preserveNullAndEmptyArrays: true },
    }]]);
    expect(ast.type).toBe("aggregate");
    if (ast.type === "aggregate") {
      const cmd = astToMongo(ast);
      expect(cmd.method).toBe("aggregate");
    }
  });

  test("$sample → MongoDB aggregate", () => {
    const ast = parseMQL("users", "aggregate", [[{
      $sample: { size: 3 },
    }]]);
    expect(ast.type).toBe("aggregate");
    if (ast.type === "aggregate") {
      const cmd = astToMongo(ast);
      expect(cmd.method).toBe("aggregate");
    }
  });

  test("$addFields → MongoDB $addFields stage", () => {
    const ast = parseMQL("users", "aggregate", [[{
      $addFields: { fullName: { $concat: ["$first", " ", "$last"] } },
    }]]);
    expect(ast.type).toBe("aggregate");
    if (ast.type === "aggregate") {
      const cmd = astToMongo(ast);
      expect(cmd.method).toBe("aggregate");
      const pipeline = cmd.args[0] as Record<string, unknown>[];
      const stage = pipeline.find(s => (s as Record<string, unknown>).$addFields) as Record<string, unknown> | undefined;
      expect(stage).toBeDefined();
    }
  });

  test("$set stage → MongoDB $set stage", () => {
    const ast = parseMQL("users", "aggregate", [[{
      $set: { status: "active" },
    }]]);
    expect(ast.type).toBe("aggregate");
    if (ast.type === "aggregate") {
      const cmd = astToMongo(ast);
      expect(cmd.method).toBe("aggregate");
    }
  });
});
