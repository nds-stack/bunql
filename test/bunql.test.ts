import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { BunQL } from "../src/index.ts";
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

    db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)");
    db.run("INSERT INTO test VALUES (1, 'hello')");
    db.run("INSERT INTO test VALUES (2, 'world')");

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

    db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)");
    db.run("INSERT INTO test VALUES (1, 'hello')");
    db.run("INSERT INTO test VALUES (2, 'world')");

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
    db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)");

    const result = db.query<{ id: number }>("SELECT * FROM test WHERE id = 999");
    expect(result.rows).toHaveLength(0);

    db.close();
  });

  test("run executes write and returns changes", async () => {
    const db = new BunQL(dbPath);
    db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)");

    const result = db.run("INSERT INTO test (value) VALUES (?)", ["hello"]);

    expect(result.changes).toBe(1);
    expect(result.lastInsertRowid).toBe(1);

    db.close();
  });

  test("run returns changes correctly", async () => {
    const db = new BunQL(dbPath);
    db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)");

    const result = db.run("INSERT INTO test (value) VALUES ('x')");
    expect(result.changes).toBe(1);

    db.close();
  });

  test("close prevents further operations", async () => {
    const db = new BunQL(dbPath);

    await db.close();
    expect(db.closed).toBe(true);

    expect(() => db.query("SELECT 1")).toThrow("Database is closed");
    expect(() => db.run("CREATE TABLE test (id INTEGER PRIMARY KEY)")).toThrow("Database is closed");
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
    db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)");

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

  test("raw getter exposes underlying Database", () => {
    const db = new BunQL(dbPath);
    expect(db.raw).toBeInstanceOf(Database);
    const stmt = db.raw.prepare("SELECT 1 AS val");
    const result = stmt.get() as { val: number };
    expect(result?.val).toBe(1);
    db.close();
  });

  test("raw getter throws after close", () => {
    const db = new BunQL(dbPath);
    db.close();
    expect(() => db.raw).toThrow("Database is closed");
  });

  test("exec runs multiple SQL statements", async () => {
    const db = new BunQL(dbPath);
    await db.exec(`
      CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT);
      INSERT INTO test VALUES (1, 'hello');
      INSERT INTO test VALUES (2, 'world');
    `);
    const result = db.query<{ id: number; val: string }>("SELECT * FROM test ORDER BY id");
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]?.val).toBe("hello");
    expect(result.rows[1]?.val).toBe("world");
    db.close();
  });

  test("exec respects write queue serialization", async () => {
    const db = new BunQL(dbPath);
    db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");

    await Promise.all([
      db.run("INSERT INTO test (val) VALUES ('a')"),
      db.exec("INSERT INTO test (val) VALUES ('b'); INSERT INTO test (val) VALUES ('c')"),
      db.run("INSERT INTO test (val) VALUES ('d')"),
    ]);

    const count = db.query<{ cnt: number }>("SELECT COUNT(*) as cnt FROM test");
    expect(count.rows[0]?.cnt).toBe(4);
    db.close();
  });

  test("PRAGMA options are applied in constructor", () => {
    const db = new BunQL(dbPath, {
      synchronous: "FULL",
      cacheSize: -8000,
      foreignKeys: true,
    });

    const syncResult = db.query<{ synchronous: number }>("PRAGMA synchronous");
    expect(syncResult.rows[0]?.synchronous).toBe(2); // FULL = 2

    const cacheResult = db.query<{ cache_size: number }>("PRAGMA cache_size");
    expect(cacheResult.rows[0]?.cache_size).toBe(-8000);

    const fkResult = db.query<{ foreign_keys: number }>("PRAGMA foreign_keys");
    expect(fkResult.rows[0]?.foreign_keys).toBe(1);

    db.close();
  });

  test("PRAGMA foreignKeys defaults to ON", () => {
    const db = new BunQL(dbPath);
    const result = db.query<{ foreign_keys: number }>("PRAGMA foreign_keys");
    expect(result.rows[0]?.foreign_keys).toBe(1);
    db.close();
  });

  test("run throws directly on invalid SQL", () => {
    const db = new BunQL(dbPath);
    expect(() => db.run("INVALID SQL")).toThrow();
    db.close();
  });

  test("onError is called when exec fails", async () => {
    const errors: Error[] = [];
    const db = new BunQL(dbPath, {
      events: {
        onError: (err) => errors.push(err),
      },
    });

    await expect(db.exec("INVALID SQL")).rejects.toThrow();
    expect(errors.length).toBeGreaterThanOrEqual(1);
    db.close();
  });

  test("metrics tracks writes, reads, and transactions", async () => {
    const db = new BunQL(dbPath);

    const m0 = db.metrics;
    expect(m0.writes.total).toBe(0);
    expect(m0.reads.total).toBe(0);

    db.run("CREATE TABLE metrics_test (id INTEGER PRIMARY KEY, val TEXT)");
    expect(db.metrics.writes.total).toBe(1);

    db.query("SELECT 1");
    expect(db.metrics.reads.total).toBeGreaterThanOrEqual(1);

    await db.transaction(async (tx) => {
      tx.run("INSERT INTO metrics_test (val) VALUES (?)", ["x"]);
    });
    expect(db.metrics.transactions.committed).toBe(1);

    db.close();
  });

  test("metrics tracks writes and reads", async () => {
    const db = new BunQL(dbPath);

    db.run("CREATE TABLE metrics_test (id INTEGER PRIMARY KEY, val TEXT)");

    db.run("INSERT INTO metrics_test (val) VALUES (?)", ["a"]);
    expect(db.metrics.writes.total).toBeGreaterThanOrEqual(1);

    db.query("SELECT 1");
    expect(db.metrics.reads.total).toBeGreaterThanOrEqual(1);

    await db.transaction(async (tx) => {
      tx.run("INSERT INTO metrics_test (val) VALUES (?)", ["x"]);
    });
    expect(db.metrics.transactions.committed).toBe(1);

    db.close();
  });

  test("cacheStats returns statement cache statistics", async () => {
    const db = new BunQL(dbPath);

    const stats = db.cacheStats;
    expect(stats.size).toBe(0);
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
    expect(stats.hitRate).toBe(0);

    // Trigger a miss
    db.query("SELECT 1 AS val");
    expect(db.cacheStats.misses).toBe(1);

    // Trigger a hit
    db.query("SELECT 1 AS val");
    expect(db.cacheStats.hits).toBe(1);
    expect(db.cacheStats.hitRate).toBeGreaterThan(0);

    db.close();
  });

  test("checkpoint runs without error", async () => {
    const db = new BunQL(dbPath);
    db.run("CREATE TABLE cp_test (id INTEGER PRIMARY KEY)");

    const result = await db.checkpoint("TRUNCATE");
    expect(result.pagesCheckpointed).toBeGreaterThanOrEqual(0);

    db.close();
  });

  test("walStatus returns status object", async () => {
    const db = new BunQL(dbPath);
    db.run("CREATE TABLE wal_test (id INTEGER PRIMARY KEY, val TEXT)");
    db.run("INSERT INTO wal_test VALUES (1, 'hello')");

    const status = await db.walStatus();
    expect(status.pageCount).toBeGreaterThan(0);
    expect(status.pageSize).toBeGreaterThan(0);
    expect(typeof status.checkpointRequired).toBe("boolean");

    db.close();
  });

  test("backup creates a valid copy", async () => {
    const db = new BunQL(dbPath);
    db.run("CREATE TABLE backup_test (id INTEGER PRIMARY KEY, val TEXT)");
    db.run("INSERT INTO backup_test VALUES (1, 'data1')");
    db.run("INSERT INTO backup_test VALUES (2, 'data2')");

    const backupPath = getTestDBPath("backup-copy");
    const result = await db.backup(backupPath);

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.size).toBeGreaterThan(0);

    // Verify backup is readable
    const { Database } = await import("bun:sqlite");
    const backupDb = new Database(backupPath);
    const rows = backupDb.query("SELECT COUNT(*) as cnt FROM backup_test").get() as { cnt: number };
    expect(rows?.cnt).toBe(2);
    backupDb.close();

    try { unlinkSync(backupPath); } catch { /* cleanup */ }

    db.close();
  });
});
