import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { BunQL } from "../src/bunql.ts";
import { StatementCache } from "../src/statement-cache.ts";
import { Database } from "bun:sqlite";
import { getTestDBPath } from "./helpers/setup.ts";
import { unlinkSync } from "fs";

describe("StatementCache", () => {
  test("creates and caches prepared statements", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)");

    const cache = new StatementCache(db, 100);

    const stmt1 = cache.get("SELECT * FROM test WHERE id = ?");
    const stmt2 = cache.get("SELECT * FROM test WHERE id = ?");

    expect(stmt1).toBe(stmt2); // same object reference
    expect(cache.hits).toBe(1);
    expect(cache.misses).toBe(1);

    cache.clear();
    db.close();
  });

  test("evicts least recently used when cache is full", () => {
    const db = new Database(":memory:");

    const cache = new StatementCache(db, 2);

    cache.get("SELECT 1 AS val");
    cache.get("SELECT 2 AS val");
    cache.get("SELECT 3 AS val"); // should evict stmt1

    expect(cache.size).toBe(2);

    // stmt1 was evicted, so getting it again should be a miss
    cache.get("SELECT 1 AS val");
    expect(cache.misses).toBe(4);

    cache.clear();
    db.close();
  });

  test("clear finalizes all statements", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)");

    const cache = new StatementCache(db, 100);
    cache.get("SELECT 1");
    cache.get("SELECT 2");

    expect(cache.size).toBe(2);

    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.hits).toBe(0);
    expect(cache.misses).toBe(0);

    db.close();
  });
});

describe("Prepared Statement", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = getTestDBPath("prepared");
  });

  afterEach(() => {
    try {
      unlinkSync(dbPath);
    } catch {
      // file may already be deleted
    }
  });

  test("prepare creates a reusable statement", async () => {
    const db = new BunQL(dbPath);
    await db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
    await db.run("INSERT INTO users (name) VALUES ('Alice')");
    await db.run("INSERT INTO users (name) VALUES ('Bob')");

    const stmt = db.prepare<{ id: number; name: string }, [string]>(
      "SELECT * FROM users WHERE name = ?"
    );

    const alice = stmt.get("Alice");
    expect(alice?.name).toBe("Alice");

    const bob = stmt.get("Bob");
    expect(bob?.name).toBe("Bob");

    const all = stmt.all("Alice");
    expect(all).toHaveLength(1);

    db.close();
  });

  test("prepare.run executes write and returns changes", async () => {
    const db = new BunQL(dbPath);
    await db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");

    const stmt = db.prepare<unknown, [string]>(
      "INSERT INTO users (name) VALUES (?)"
    );

    const result = stmt.run("Alice");
    expect(result.changes).toBe(1);

    const users = db.query<{ name: string }>("SELECT name FROM users");
    expect(users.rows).toHaveLength(1);
    expect(users.rows[0]?.name).toBe("Alice");

    db.close();
  });

  test("prepare.finalize cleans up the statement", async () => {
    const db = new BunQL(dbPath);

    const stmt = db.prepare<unknown, [string]>("SELECT ? AS val");
    stmt.finalize();

    db.close();
  });
});

describe("Batch", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = getTestDBPath("batch");
  });

  afterEach(() => {
    try {
      unlinkSync(dbPath);
    } catch {
      // file may already be deleted
    }
  });

  test("batch executes multiple operations", async () => {
    const db = new BunQL(dbPath);
    await db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");

    const results = await db.batch([
      { sql: "INSERT INTO users (name) VALUES (?)", params: ["Alice"] },
      { sql: "INSERT INTO users (name) VALUES (?)", params: ["Bob"] },
      { sql: "INSERT INTO users (name) VALUES (?)", params: ["Charlie"] },
    ]);

    expect(results).toHaveLength(3);
    expect(results[0]?.changes).toBe(1);
    expect(results[1]?.changes).toBe(1);
    expect(results[2]?.changes).toBe(1);

    const users = db.query<{ name: string }>("SELECT name FROM users ORDER BY id");
    expect(users.rows).toHaveLength(3);
    expect(users.rows[0]?.name).toBe("Alice");
    expect(users.rows[2]?.name).toBe("Charlie");

    db.close();
  });

  test("batch rolls back all operations on failure", async () => {
    const db = new BunQL(dbPath);
    await db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");

    try {
      await db.batch([
        { sql: "INSERT INTO users (name) VALUES (?)", params: ["Alice"] },
        { sql: "INSERT INTO nonexistent (name) VALUES (?)", params: ["Bob"] },
      ]);
      expect.unreachable();
    } catch {
      // expected rollback
    }

    const users = db.query<{ name: string }>("SELECT name FROM users ORDER BY id");
    expect(users.rows).toHaveLength(0);

    db.close();
  });

  test("batch with single operation still works", async () => {
    const db = new BunQL(dbPath);
    await db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");

    const results = await db.batch([
      { sql: "INSERT INTO users (name) VALUES (?)", params: ["Solo"] },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]?.changes).toBe(1);

    db.close();
  });
});
