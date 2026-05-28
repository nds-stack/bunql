import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { BunQL } from "../../src/bunql.ts";
import { getTestDBPath } from "../helpers/setup.ts";
import { unlinkSync } from "fs";

describe("SQLite integration", () => {
  let dbPath: string;
  let db: BunQL;

  beforeEach(() => {
    dbPath = getTestDBPath("int-sqlite");
    db = new BunQL(dbPath);
    db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)");
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(dbPath); } catch { /* ok */ }
  });

  test("INSERT via run() returns changes", () => {
    const r = db.run("INSERT INTO users (name, email) VALUES (?, ?)", ["Alice", "a@test.com"]);
    expect(r.changes).toBe(1);
    expect(r.lastInsertRowid).toBe(1);
  });

  test("SELECT via query() returns rows", () => {
    db.run("INSERT INTO users (name, email) VALUES ('Alice', 'a@test.com')");
    db.run("INSERT INTO users (name, email) VALUES ('Bob', 'b@test.com')");
    const res = db.query<{ id: number; name: string; email: string }>("SELECT * FROM users ORDER BY id");
    expect(res.rows).toHaveLength(2);
    expect(res.rows[0]?.name).toBe("Alice");
    expect(res.rows[1]?.name).toBe("Bob");
  });

  test("SELECT with parameterized WHERE", () => {
    db.run("INSERT INTO users (name, email) VALUES ('Alice', 'a@test.com')");
    db.run("INSERT INTO users (name, email) VALUES ('Bob', 'b@test.com')");
    const res = db.query<{ name: string }>("SELECT name FROM users WHERE id = ?", [2]);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]?.name).toBe("Bob");
  });

  test("UPDATE modifies rows", () => {
    db.run("INSERT INTO users (name, email) VALUES ('Alice', 'a@test.com')");
    const r = db.run("UPDATE users SET email = ? WHERE name = ?", ["new@test.com", "Alice"]);
    expect(r.changes).toBe(1);
    const res = db.query<{ email: string }>("SELECT email FROM users WHERE name = 'Alice'");
    expect(res.rows[0]?.email).toBe("new@test.com");
  });

  test("DELETE removes rows", () => {
    db.run("INSERT INTO users (name, email) VALUES ('Alice', 'a@test.com')");
    db.run("INSERT INTO users (name, email) VALUES ('Bob', 'b@test.com')");
    const r = db.run("DELETE FROM users WHERE name = ?", ["Alice"]);
    expect(r.changes).toBe(1);
    const res = db.query<{ count: number }>("SELECT COUNT(*) as count FROM users");
    expect(res.rows[0]?.count).toBe(1);
  });

  test("transaction commits", async () => {
    await db.transaction(async (tx) => {
      tx.run("INSERT INTO users (name, email) VALUES (?, ?)", ["Alice", "a@test.com"]);
      tx.run("INSERT INTO users (name, email) VALUES (?, ?)", ["Bob", "b@test.com"]);
      return "ok";
    });
    const res = db.query<{ count: number }>("SELECT COUNT(*) as count FROM users");
    expect(res.rows[0]?.count).toBe(2);
  });

  test("transaction rolls back on error", async () => {
    db.run("INSERT INTO users (name, email) VALUES ('Initial', 'i@test.com')");
    try {
      await db.transaction(async (tx) => {
        tx.run("INSERT INTO users (name, email) VALUES (?, ?)", ["Alice", "a@test.com"]);
        throw new Error("fail");
      });
      expect.unreachable();
    } catch { /* expected */ }
    const res = db.query<{ count: number }>("SELECT COUNT(*) as count FROM users");
    expect(res.rows[0]?.count).toBe(1);
  });

  test("tagged template sql() with .all()/.get()/.run()", async () => {
    db.run("INSERT INTO users (name, email) VALUES ('Alice', 'a@test.com')");
    db.run("INSERT INTO users (name, email) VALUES ('Bob', 'b@test.com')");

    const all = await db.sql`SELECT * FROM users`.all();
    expect(all).toHaveLength(2);

    const single = await db.sql`SELECT * FROM users WHERE id = ${1}`.get();
    expect(single?.name).toBe("Alice");

    const ins = db.sql`INSERT INTO users (name, email) VALUES (${"Charlie"}, ${"c@test.com"})`.run();
    expect(ins.changes).toBe(1);
  });

  test("batch executes multiple operations", async () => {
    const results = await db.batch([
      { sql: "INSERT INTO users (name, email) VALUES (?, ?)", params: ["Alice", "a@test.com"] },
      { sql: "INSERT INTO users (name, email) VALUES (?, ?)", params: ["Bob", "b@test.com"] },
      { sql: "UPDATE users SET email = ? WHERE name = ?", params: ["updated@test.com", "Alice"] },
    ]);
    expect(results).toHaveLength(3);
    expect(results[0]?.changes).toBe(1);
    expect(results[1]?.changes).toBe(1);
    expect(results[2]?.changes).toBe(1);

    const alice = db.query<{ email: string }>("SELECT email FROM users WHERE name = 'Alice'");
    expect(alice.rows[0]?.email).toBe("updated@test.com");
  });

  test("query returns empty array for no match", () => {
    const res = db.query("SELECT * FROM users WHERE name = 'Nobody'");
    expect(res.rows).toHaveLength(0);
  });

  test("invalid SQL throws", () => {
    expect(() => db.run("INVALID SQL")).toThrow();
  });
});
