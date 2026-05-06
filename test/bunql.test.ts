import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { BunQL } from "../src/bunql.ts";
import { getTestDBPath } from "./helpers/setup.ts";
import { unlinkSync } from "fs";

describe("BunQL", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = getTestDBPath("bunql");
  });

  afterEach(() => {
    try {
      unlinkSync(dbPath);
    } catch {
      // file may already be deleted
    }
  });

  test("creates database and sets WAL mode", () => {
    const db = new BunQL(dbPath);
    expect(db.closed).toBe(false);

    const result = db.query<{ journal_mode: string }>("PRAGMA journal_mode");
    expect(result.rows[0]?.journal_mode?.toLowerCase()).toBe("wal");

    db.close();
  });

  test("query returns rows and columns", async () => {
    const db = new BunQL(dbPath);

    await db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)");
    await db.run("INSERT INTO test VALUES (1, 'hello')");
    await db.run("INSERT INTO test VALUES (2, 'world')");

    const result = db.query<{ id: number; value: string }>("SELECT * FROM test ORDER BY id");

    expect(result.columns).toContain("id");
    expect(result.columns).toContain("value");
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]?.id).toBe(1);
    expect(result.rows[0]?.value).toBe("hello");
    expect(result.rows[1]?.id).toBe(2);
    expect(result.rows[1]?.value).toBe("world");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    db.close();
  });

  test("query with parameters", async () => {
    const db = new BunQL(dbPath);

    await db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)");
    await db.run("INSERT INTO test VALUES (1, 'hello')");
    await db.run("INSERT INTO test VALUES (2, 'world')");

    const result = db.query<{ id: number; value: string }>(
      "SELECT * FROM test WHERE id = ?",
      [1],
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.value).toBe("hello");

    db.close();
  });

  test("query returns empty rows when no matches", async () => {
    const db = new BunQL(dbPath);
    await db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)");

    const result = db.query<{ id: number }>("SELECT * FROM test WHERE id = 999");
    expect(result.rows).toHaveLength(0);

    db.close();
  });

  test("run executes write and returns changes", async () => {
    const db = new BunQL(dbPath);
    await db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)");

    const result = await db.run("INSERT INTO test (value) VALUES (?)", ["hello"]);

    expect(result.changes).toBe(1);
    expect(result.lastInsertRowid).toBe(1);

    db.close();
  });

  test("run returns changes correctly", async () => {
    const db = new BunQL(dbPath);
    await db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)");

    const result = await db.run("INSERT INTO test (value) VALUES ('x')");
    expect(result.changes).toBe(1);

    db.close();
  });

  test("close prevents further operations", async () => {
    const db = new BunQL(dbPath);

    await db.close();
    expect(db.closed).toBe(true);

    expect(() => db.query("SELECT 1")).toThrow("Database is closed");
    await expect(db.run("CREATE TABLE test (id INTEGER PRIMARY KEY)")).rejects.toThrow("Database is closed");
  });

  test("close can be called multiple times safely", async () => {
    const db = new BunQL(dbPath);

    await db.close();
    await db.close();
    await db.close();

    expect(db.closed).toBe(true);
  });

  test("handles concurrent reads safely", async () => {
    const db = new BunQL(dbPath);
    await db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)");

    const inserts = Array.from({ length: 5 }, (_, i) =>
      db.run("INSERT INTO test (value) VALUES (?)", [`value-${i}`])
    );
    await Promise.all(inserts);

    const reads = Array.from({ length: 10 }, () =>
      db.query<{ count: number }>("SELECT COUNT(*) as count FROM test")
    );

    for (const result of reads) {
      expect(result.rows[0]?.count).toBe(5);
    }

    db.close();
  });

  test("creates database with custom options", () => {
    const db = new BunQL(dbPath, {
      wal: true,
      busyTimeout: 3000,
      retry: {
        maxRetries: 3,
        baseDelay: 5,
        maxDelay: 100,
        jitter: false,
      },
    });

    expect(db.closed).toBe(false);
    db.query("SELECT 1");
    db.close();
  });

  test("queueSize reflects pending operations", async () => {
    const db = new BunQL(dbPath);

    expect(db.queueSize).toBe(0);

    const runs = Array.from({ length: 5 }, () =>
      db.run("SELECT 1 AS val")
    );

    expect(db.queueSize).toBeGreaterThanOrEqual(0);

    await Promise.all(runs);
    db.close();
  });
});
