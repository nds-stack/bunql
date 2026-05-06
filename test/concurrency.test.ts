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
});
