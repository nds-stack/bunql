import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { BunQL } from "../src/bunql.ts";
import { getTestDBPath } from "./helpers/setup.ts";
import { unlinkSync } from "fs";

describe("Concurrency", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = getTestDBPath("concurrency");
  });

  afterEach(() => {
    try {
      unlinkSync(dbPath);
    } catch {
      // file may already be deleted
    }
  });

  test("100 concurrent writes all succeed", async () => {
    const db = new BunQL(dbPath);
    await db.run("CREATE TABLE counters (id INTEGER PRIMARY KEY AUTOINCREMENT, val INTEGER)");

    const writes = Array.from({ length: 100 }, (_, i) =>
      db.run("INSERT INTO counters (val) VALUES (?)", [i])
    );

    const results = await Promise.all(writes);

    expect(results).toHaveLength(100);
    for (const r of results) {
      expect(r.changes).toBe(1);
    }

    const count = db.query<{ cnt: number }>("SELECT COUNT(*) as cnt FROM counters");
    expect(count.rows[0]?.cnt).toBe(100);

    db.close();
  });

  test("concurrent reads during writes never block readers", async () => {
    const db = new BunQL(dbPath);
    await db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");

    // Start a batch of writes
    const writePromises = Array.from({ length: 50 }, (_, i) =>
      db.run("INSERT INTO test (val) VALUES (?)", [`value-${i}`])
    );

    // Read concurrently with writes
    const readPromises = Array.from({ length: 20 }, () =>
      Promise.resolve().then(() => db.query("SELECT COUNT(*) as cnt FROM test"))
    );

    const allResults = await Promise.all([...writePromises, ...readPromises]);
    expect(allResults.length).toBe(70);

    db.close();
  });

  test("concurrent transactions are serialized correctly", async () => {
    const db = new BunQL(dbPath);
    await db.run("CREATE TABLE account (id INTEGER PRIMARY KEY, balance INTEGER)");
    await db.run("INSERT INTO account VALUES (1, 100)");

    const transfers = Array.from({ length: 20 }, () =>
      db.transaction(async (tx) => {
        const rows = tx.query<{ balance: number }>("SELECT balance FROM account WHERE id = 1");
        const current = rows[0]?.balance ?? 0;
        await tx.run("UPDATE account SET balance = ? WHERE id = 1", [current + 1]);
      })
    );

    await Promise.all(transfers);

    const result = db.query<{ balance: number }>("SELECT balance FROM account WHERE id = 1");
    expect(result.rows[0]?.balance).toBe(120);

    db.close();
  });

  test("queue drains correctly under high load", async () => {
    const db = new BunQL(dbPath);
    await db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");

    const promises = Array.from({ length: 200 }, (_, i) =>
      db.run("INSERT INTO test (val) VALUES (?)", [`val-${i}`])
    );

    await Promise.all(promises);

    expect(db.queueSize).toBe(0);
    expect(db.isProcessing).toBe(false);

    const count = db.query<{ cnt: number }>("SELECT COUNT(*) as cnt FROM test");
    expect(count.rows[0]?.cnt).toBe(200);

    db.close();
  });

  test("graceful close under active operations", async () => {
    const db = new BunQL(dbPath);
    await db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");

    // Start operations
    Array.from({ length: 10 }, (_, i) =>
      db.run("INSERT INTO test (val) VALUES (?)", [`val-${i}`]).catch(() => {})
    );

    // Close while operations may still be in flight
    await db.close();

    // Should not throw
    expect(db.closed).toBe(true);
  });

  test("mixed read/write concurrency", async () => {
    const db = new BunQL(dbPath);
    await db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");

    const operations: Promise<unknown>[] = [];

    // Interleave reads and writes
    for (let i = 0; i < 50; i++) {
      operations.push(db.run("INSERT INTO test (val) VALUES (?)", [`write-${i}`]));
      if (i % 2 === 0) {
        operations.push(Promise.resolve(db.query("SELECT COUNT(*) as cnt FROM test")));
      }
    }

    await Promise.all(operations);

    const final = db.query<{ cnt: number }>("SELECT COUNT(*) as cnt FROM test");
    expect(final.rows[0]?.cnt).toBe(50);

    db.close();
  });

  test("handles rapid enqueue/dequeue cycles", async () => {
    const db = new BunQL(dbPath);
    await db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");

    for (let round = 0; round < 10; round++) {
      const promises = Array.from({ length: 10 }, (_, i) =>
        db.run("INSERT INTO test (val) VALUES (?)", [`round-${round}-item-${i}`])
      );
      await Promise.all(promises);
    }

    const count = db.query<{ cnt: number }>("SELECT COUNT(*) as cnt FROM test");
    expect(count.rows[0]?.cnt).toBe(100);

    db.close();
  });

  test("close while write spam does not leak errors", async () => {
    const db = new BunQL(dbPath);
    await db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");

    // Fire many concurrent writes
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 50; i++) {
      promises.push(
        db.run("INSERT INTO test (val) VALUES (?)", [`spam-${i}`]).catch(() => {}),
      );
    }

    // Close immediately without waiting for all writes
    await db.close();
    expect(db.closed).toBe(true);

    // All promises should settle (resolve or reject)
    await Promise.allSettled(promises);
  });

  test("statement cache cleanup on close", async () => {
    const db = new BunQL(dbPath);
    await db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");

    // Populate the statement cache
    for (let i = 0; i < 10; i++) {
      db.query(`SELECT ${i} AS val`);
    }

    // Close should finalize all cached statements without throwing
    await db.close();
    expect(db.closed).toBe(true);
  });

  test("long-running queue stability", async () => {
    const db = new BunQL(dbPath);
    await db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");

    // 500 sequential writes to test stability
    for (let i = 0; i < 500; i++) {
      await db.run("INSERT INTO test (val) VALUES (?)", [`seq-${i}`]);
    }

    const count = db.query<{ cnt: number }>("SELECT COUNT(*) as cnt FROM test");
    expect(count.rows[0]?.cnt).toBe(500);

    db.close();
  });

  test("transaction storm with mixed operations", async () => {
    const db = new BunQL(dbPath);
    await db.run("CREATE TABLE account (id INTEGER PRIMARY KEY, balance INTEGER)");
    await db.run("INSERT INTO account VALUES (1, 1000)");
    await db.run("INSERT INTO account VALUES (2, 0)");

    // 50 concurrent transactions simulating transfers
    const txs = Array.from({ length: 50 }, (_, i) =>
      db.transaction(async (tx) => {
        const from = tx.query<{ balance: number }>(
          "SELECT balance FROM account WHERE id = 1",
        );
        const amount = 10;
        const currentFrom = from[0]?.balance ?? 0;

        if (currentFrom >= amount) {
          await tx.run("UPDATE account SET balance = balance - ? WHERE id = 1", [amount]);
          await tx.run("UPDATE account SET balance = balance + ? WHERE id = 2", [amount]);
        }
        return i;
      }),
    );

    const results = await Promise.all(txs);
    expect(results).toHaveLength(50);

    const balances = db.query<{ balance: number }>(
      "SELECT balance FROM account ORDER BY id",
    );
    const total = (balances.rows[0]?.balance ?? 0) + (balances.rows[1]?.balance ?? 0);
    expect(total).toBe(1000); // Total should be preserved

    db.close();
  });

  test("stress: interleaved read/write/transaction storm", async () => {
    const db = new BunQL(dbPath);
    await db.run("CREATE TABLE stress (id INTEGER PRIMARY KEY, val TEXT)");

    const allOps: Promise<unknown>[] = [];

    // Mix of writes
    for (let i = 0; i < 30; i++) {
      allOps.push(db.run("INSERT INTO stress (val) VALUES (?)", [`write-${i}`]));
    }

    // Mix of reads
    for (let i = 0; i < 30; i++) {
      allOps.push(Promise.resolve(db.query("SELECT COUNT(*) as cnt FROM stress")));
    }

    // Mix of transactions
    for (let i = 0; i < 10; i++) {
      allOps.push(
        db.transaction(async (tx) => {
          const rows = tx.query<{ val: string }>("SELECT val FROM stress ORDER BY id DESC LIMIT 1");
          return rows;
        }),
      );
    }

    await Promise.all(allOps);

    const final = db.query<{ cnt: number }>("SELECT COUNT(*) as cnt FROM stress");
    expect(final.rows[0]?.cnt).toBe(30);

    db.close();
  });
});
