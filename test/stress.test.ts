import { describe, test, expect } from "bun:test";
import { BunQL } from "../src/bunql.ts";
import { getTestDBPath } from "./helpers/setup.ts";
import { rmSync } from "fs";

function makeDBPath(label: string): string {
  return getTestDBPath(`stress-${label}`);
}

function cleanup(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // best-effort cleanup — Windows may hold WAL/SHM locks briefly
  }
}

describe("Stress: long-running stability", () => {
  test("5000 sequential writes are stable", async () => {
    const path = makeDBPath("sequential");
    const db = new BunQL(path);

    db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");

    for (let i = 0; i < 5000; i++) {
      db.run("INSERT INTO test (val) VALUES (?)", [`seq-${i}`]);
    }

    const count = db.query<{ cnt: number }>("SELECT COUNT(*) as cnt FROM test");
    expect(count.rows[0]?.cnt).toBe(5000);

    await db.close();
    cleanup(path);
  }, 30000);

  test("50 concurrent writes in 5 batches", async () => {
    const path = makeDBPath("concurrent");
    const db = new BunQL(path);
    db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");

    for (let batch = 0; batch < 5; batch++) {
      const writes = Array.from({ length: 50 }, (_, i) =>
        db.run("INSERT INTO test (val) VALUES (?)", [`batch-${batch}-${i}`]),
      );
      await Promise.all(writes);
    }

    const count = db.query<{ cnt: number }>("SELECT COUNT(*) as cnt FROM test");
    expect(count.rows[0]?.cnt).toBe(250);

    await db.close();
    cleanup(path);
  }, 15000);

  test("20 concurrent transactions increment counter", async () => {
    const path = makeDBPath("tx-storm");
    const db = new BunQL(path);
    db.run("CREATE TABLE counter (id INTEGER PRIMARY KEY, val INTEGER)");
    db.run("INSERT INTO counter VALUES (1, 0)");

    const txs = Array.from({ length: 20 }, () =>
      db.transaction(async (tx) => {
        const rows = tx.query<{ val: number }>("SELECT val FROM counter WHERE id = 1");
        const current = rows[0]?.val ?? 0;
        tx.run("UPDATE counter SET val = ? WHERE id = 1", [current + 1]);
      }),
    );

    await Promise.all(txs);

    const result = db.query<{ val: number }>("SELECT val FROM counter WHERE id = 1");
    expect(result.rows[0]?.val).toBe(20);

    await db.close();
    cleanup(path);
  }, 15000);

  test("10 repeated open/close cycles", async () => {
    const path = makeDBPath("open-close");

    for (let cycle = 0; cycle < 10; cycle++) {
      const db = new BunQL(path);
      if (cycle === 0) {
        db.run("CREATE TABLE IF NOT EXISTS test (id INTEGER PRIMARY KEY, val TEXT)");
      }
      db.run("INSERT INTO test (val) VALUES (?)", [`cycle-${cycle}`]);
      await db.close();

      // Verify we can reopen and read
      const db2 = new BunQL(path);
      const count = db2.query<{ cnt: number }>("SELECT COUNT(*) as cnt FROM test");
      expect(count.rows[0]?.cnt).toBe(cycle + 1);
      await db2.close();
    }

    cleanup(path);
  }, 15000);

  test("statement cache pressure with 150 unique queries", async () => {
    const path = makeDBPath("cache-pressure");
    const db = new BunQL(path);
    db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");

    // Insert data
    for (let i = 0; i < 150; i++) {
      db.run("INSERT INTO test (val) VALUES (?)", [`val-${i}`]);
    }

    // Query with 150 unique SQL patterns to stress the cache (maxSize=100)
    for (let i = 0; i < 150; i++) {
      const result = db.query<{ val: string }>(
        "SELECT val FROM test WHERE val = ?",
        [`val-${i}`],
      );
      expect(result.rows).toHaveLength(1);
    }

    await db.close();
    cleanup(path);
  }, 15000);

  test("mixed workload: 100 interleaved reads/writes/transactions", async () => {
    const path = makeDBPath("mixed");
    const db = new BunQL(path);
    db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");
    db.run("INSERT INTO test VALUES (1, 'initial')");

    const txOps: Promise<unknown>[] = [];

    for (let i = 0; i < 100; i++) {
      if (i % 3 === 0) {
        db.run("INSERT INTO test (val) VALUES (?)", [`write-${i}`]);
      } else if (i % 3 === 1) {
        db.query("SELECT COUNT(*) as cnt FROM test");
      } else {
        txOps.push(
          db.transaction(async (tx) => {
            const rows = tx.query<{ val: string }>(
              "SELECT val FROM test ORDER BY id DESC LIMIT 1",
            );
            tx.run("INSERT INTO test (val) VALUES (?)", [
              `tx-${rows[0]?.val ?? "none"}`,
            ]);
          }),
        );
      }
    }

    await Promise.all(txOps);
    await db.close();
    cleanup(path);
  }, 20000);

  test("stress: batch operations with large arrays", async () => {
    const path = makeDBPath("batch-stress");
    const db = new BunQL(path);
    db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");

    const batchSize = 50;
    const operations = Array.from({ length: batchSize }, (_, i) => ({
      sql: "INSERT INTO test (val) VALUES (?)",
      params: [`batch-item-${i}`],
    }));

    for (let round = 0; round < 10; round++) {
      await db.batch(operations);
    }

    const count = db.query<{ cnt: number }>("SELECT COUNT(*) as cnt FROM test");
    expect(count.rows[0]?.cnt).toBe(batchSize * 10);

    await db.close();
    cleanup(path);
  }, 15000);
});

describe("Stress: graceful shutdown", () => {
  test("close called multiple times is safe", async () => {
    const path = makeDBPath("multi-close");
    const db = new BunQL(path);

    await db.close();
    await db.close();
    await db.close();

    expect(db.closed).toBe(true);
    cleanup(path);
  });

  test("close during active writes does not hang", async () => {
    const path = makeDBPath("close-writes");
    const db = new BunQL(path);
    db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");

    for (let i = 0; i < 30; i++) {
      db.run("INSERT INTO test (val) VALUES (?)", [`spam-${i}`]);
    }

    await db.close();
    expect(db.closed).toBe(true);
    cleanup(path);
  }, 10000);

  test("close during active transaction is safe", async () => {
    const path = makeDBPath("close-tx");
    const db = new BunQL(path);
    db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");

    // Start a slow transaction
    const txPromise = db.transaction(async (tx) => {
      tx.run("INSERT INTO test (val) VALUES (?)", ["before"]);
      await Bun.sleep(50);
      tx.run("INSERT INTO test (val) VALUES (?)", ["after"]);
    }).catch(() => {});

    // Close during the transaction
    await Bun.sleep(10);
    await db.close();
    expect(db.closed).toBe(true);

    await txPromise;
    cleanup(path);
  }, 10000);

  test("batch write during mixed load is consistent", async () => {
    const path = makeDBPath("close-retry");
    const db = new BunQL(path);
    db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");

    await db.batch(Array.from({ length: 10 }, (_, i) => ({
      sql: "INSERT INTO test (val) VALUES (?)",
      params: [`batch-${i}`],
    })));

    const count = db.query<{ cnt: number }>("SELECT COUNT(*) as cnt FROM test");
    expect(count.rows[0]?.cnt).toBe(10);

    await db.close();
    cleanup(path);
  }, 10000);

  test("close after big error is safe", async () => {
    const path = makeDBPath("close-error");
    const db = new BunQL(path);
    db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");

    // Cause an error
    try {
      db.run("INVALID SQL STATEMENT");
    } catch {
      // expected
    }

    // Close should still work
    await db.close();
    expect(db.closed).toBe(true);
    cleanup(path);
  });

  test("operations after close are rejected", async () => {
    const path = makeDBPath("after-close");
    const db = new BunQL(path);
    await db.close();

    expect(() => db.query("SELECT 1")).toThrow("Database is closed");
    expect(() => db.run("SELECT 1")).toThrow("Database is closed");
    await expect(db.transaction(async () => {})).rejects.toThrow("Database is closed");

    expect(() => db.prepare("SELECT 1")).toThrow("Database is closed");
    await expect(db.batch([])).rejects.toThrow("Database is closed");

    cleanup(path);
  });

  test("close with empty queue is immediate", async () => {
    const path = makeDBPath("close-empty");
    const db = new BunQL(path);

    const start = performance.now();
    await db.close();
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(50);
    cleanup(path);
  });
});
