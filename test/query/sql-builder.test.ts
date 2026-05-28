import { describe, test, expect } from "bun:test";
import { sql, SqlQuery } from "../../src/query/sql-builder.ts";
import { MqlQuery } from "../../src/query/mql-builder.ts";
import {
  eq, neq, gt, lt, gte, lte,
  and, or, not, like, inList, between,
  isNull, isNotNull, asc, desc,
  col, lit, func,
} from "../../src/query/conditions.ts";

describe("sql tagged template", () => {
  test("basic query", () => {
    const q = sql`SELECT * FROM users WHERE id = ${1}`;
    expect(q.sql).toBe("SELECT * FROM users WHERE id = ?");
    expect(q.params).toEqual([1]);
  });

  test("multiple params", () => {
    const q = sql`SELECT * FROM users WHERE name = ${"Alice"} AND age > ${25}`;
    expect(q.sql).toBe("SELECT * FROM users WHERE name = ? AND age > ?");
    expect(q.params).toEqual(["Alice", 25]);
  });

  test("array param expands to IN clause", () => {
    const q = sql`SELECT * FROM users WHERE id IN (${[1, 2, 3]})`;
    expect(q.sql).toBe("SELECT * FROM users WHERE id IN (?, ?, ?)");
    expect(q.params).toEqual([1, 2, 3]);
  });

  test("no params", () => {
    const q = sql`SELECT * FROM users`;
    expect(q.sql).toBe("SELECT * FROM users");
    expect(q.params).toEqual([]);
  });

  test("toSQL returns parsed SQL", () => {
    const q = sql`SELECT name, email FROM users WHERE age > ${25}`;
    const generated = q.toSQL();
    expect(generated).toContain("SELECT");
    expect(generated).toContain("FROM");
  });
});

describe("SqlQuery", () => {
  test("all() without executor returns []", () => {
    const q = new SqlQuery("SELECT 1", []);
    expect(q.all()).toEqual([]);
  });

  test("get() without executor returns null", () => {
    const q = new SqlQuery("SELECT 1", []);
    expect(q.get()).toBeNull();
  });

  test("all() with mock executor", () => {
    const q = new SqlQuery("SELECT * FROM users WHERE id = ?", [1], {
      executeSQL: () => ({
        columns: ["id", "name"],
        rows: [{ id: 1, name: "Alice" }],
      }),
      executeRun: () => ({ changes: 0, lastInsertRowid: 0 }),
      isAsync: false,
    });
    const result = q.all<{ id: number; name: string }>();
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(1);
    expect(result[0]!.name).toBe("Alice");
  });

  test("get() with mock executor", () => {
    const q = new SqlQuery("SELECT * FROM users WHERE id = ?", [1], {
      executeSQL: () => ({
        columns: ["id", "name"],
        rows: [{ id: 1, name: "Alice" }],
      }),
      executeRun: () => ({ changes: 0, lastInsertRowid: 0 }),
      isAsync: false,
    });
    const result = q.get<{ id: number; name: string }>();
    expect(result).not.toBeNull();
    expect(result!.id).toBe(1);
  });

  test("run() with mock executor", () => {
    const q = new SqlQuery("INSERT INTO users (name) VALUES (?)", ["Bob"], {
      executeSQL: () => ({ columns: [], rows: [] }),
      executeRun: () => ({ changes: 1, lastInsertRowid: 42 }),
      isAsync: false,
    });
    const result = q.run();
    expect(result.changes).toBe(1);
    expect(result.lastInsertRowid).toBe(42);
  });
});

describe("MqlQuery", () => {
  test("find with filter", () => {
    const q = new MqlQuery("users");
    const cmd = q.find({ age: { $gt: 25 } }).toCommand();
    expect(cmd.method).toBe("find");
  });

  test("find with project and sort", () => {
    const q = new MqlQuery("users");
    const cmd = q.find({}).project({ name: 1 }).sort({ age: -1 }).limit(10).skip(5).toCommand();
    expect(cmd.method).toBe("find");
  });

  test("aggregate pipeline", () => {
    const q = new MqlQuery("orders");
    const cmd = q.aggregate([
      { $match: { status: "active" } },
      { $group: { _id: "$category", count: { $sum: 1 } } },
    ]).toCommand();
    expect(cmd.method).toBe("aggregate");
  });

  test("insertOne", () => {
    const q = new MqlQuery("users");
    const cmd = q.insertOne({ name: "Alice", age: 30 }).toCommand();
    expect(cmd.method).toBe("insertOne");
  });

  test("updateOne", () => {
    const q = new MqlQuery("users");
    const cmd = q.updateOne({ _id: 1 }, { $set: { name: "Bob" } }).toCommand();
    expect(cmd.method).toBe("updateOne");
  });

  test("deleteOne", () => {
    const q = new MqlQuery("users");
    const cmd = q.deleteOne({ _id: 1 }).toCommand();
    expect(cmd.method).toBe("deleteOne");
  });

  test("toArray without executor returns []", () => {
    const q = new MqlQuery("users");
    expect(q.find({}).toArray()).toEqual([]);
  });
});

describe("conditions", () => {
  test("eq condition", () => {
    const c = eq(col("id"), 1);
    expect(c.type).toBe("eq");
    expect(c.left.name).toBe("id");
    expect(c.right).toBe(1);
  });

  test("and condition", () => {
    const c = and(eq(col("age"), 25), gt(col("salary"), 50000));
    expect(c.type).toBe("and");
    expect(c.conditions).toHaveLength(2);
  });

  test("or condition", () => {
    const c = or(eq(col("status"), "active"), eq(col("status"), "pending"));
    expect(c.type).toBe("or");
    expect(c.conditions).toHaveLength(2);
  });

  test("like condition", () => {
    const c = like(col("name"), "%Alice%");
    expect(c.type).toBe("like");
    expect(c.pattern).toBe("%Alice%");
  });

  test("inList condition", () => {
    const c = inList(col("id"), [1, 2, 3]);
    expect(c.type).toBe("in");
    expect(c.values).toEqual([1, 2, 3]);
  });

  test("between condition", () => {
    const c = between(col("age"), 18, 65);
    expect(c.type).toBe("between");
    expect(c.min).toBe(18);
    expect(c.max).toBe(65);
  });

  test("isNull condition", () => {
    const c = isNull(col("deleted_at"));
    expect(c.type).toBe("isNull");
  });

  test("orderBy helpers", () => {
    expect(asc(col("name")).direction).toBe("asc");
    expect(desc(col("name")).direction).toBe("desc");
  });

  test("func helper", () => {
    const f = func("COUNT", lit(1));
    expect(f.func).toBe("COUNT");
    expect(f.args).toHaveLength(1);
  });
});

describe("BunQL sql() / mql()", () => {
  test("BunQL.sql returns SqlQuery", async () => {
    const { BunQL } = await import("../../src/bunql.ts");
    const db = new BunQL(":memory:");
    db.run("CREATE TABLE IF NOT EXISTS test (id INTEGER PRIMARY KEY, name TEXT)");
    db.run("INSERT INTO test (name) VALUES (?)", ["Alice"]);

    const q = db.sql`SELECT * FROM test WHERE name = ${"Alice"}`;
    expect(q).toBeInstanceOf(SqlQuery);
    expect(q.sql).toBe("SELECT * FROM test WHERE name = ?");
    expect(q.params).toEqual(["Alice"]);

    const rows = q.all<{ id: number; name: string }>();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Alice");

    db.close();
  });

  test("BunQL.mql returns MqlQuery", () => {
    const { BunQL } = require("../../src/bunql.ts");
    const db = new BunQL(":memory:");
    const q = db.mql("users");
    expect(q).toBeInstanceOf(MqlQuery);
    expect(q.collection).toBe("users");
    db.close();
  });
});
