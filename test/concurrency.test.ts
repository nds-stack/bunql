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

  test("100 sequential writes all succeed", () => {
    const db = new BunQL(dbPath);
    db.run("CREATE TABLE counters (id INTEGER PRIMARY KEY AUTOINCREMENT, val INTEGER)");

    for (let i = 0; i < 100; i++) {
      const result = db.run("INSERT INTO counters (val) VALUES (?)", [i]);
      expect(result.changes).toBe(1);
    }

    const count = db.query<{ cnt: number }>("SELECT COUNT(*) as cnt FROM counters");
    expect(count.rows[0]?.cnt).toBe(100);

    db.close();
  });

  test("reads during writes never block readers", () => {
    const db = new BunQL(dbPath);
    db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");

    for (let i = 0; i < 50; i++) {
      db.run("INSERT INTO test (val) VALUES (?)", [`value-${i}`]);
    }

    const result = db.query<{ cnt: number }>("SELECT COUNT(*) as cnt FROM test");
    expect(result.rows[0]?.cnt).toBe(50);

    db.close();
  });

  test("concurrent transactions are serialized correctly", async () => {
    const db = new BunQL(dbPath);
    db.run("CREATE TABLE account (id INTEGER PRIMARY KEY, balance INTEGER)");
    db.run("INSERT INTO account VALUES (1, 100)");

    const transfers = Array.from({ length: 20 }, () =>
      db.transaction(async (tx) => {
        const rows = tx.query<{ balance: number }>("SELECT balance FROM account WHERE id = 1");
        const current = rows[0]?.balance ?? 0;
        tx.run("UPDATE account SET balance = ? WHERE id = 1", [current + 1]);
      })
    );

    await Promise.all(transfers);

    const result = db.query<{ balance: number }>("SELECT balance FROM account WHERE id = 1");
    expect(result.rows[0]?.balance).toBe(120);

    db.close();
  });

  test("sequential writes under high load", () => {
    const db = new BunQL(dbPath);
    db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");

    for (let i = 0; i < 200; i++) {
      db.run("INSERT INTO test (val) VALUES (?)", [`val-${i}`]);
    }

    const count = db.query<{ cnt: number }>("SELECT COUNT(*) as cnt FROM test");
    expect(count.rows[0]?.cnt).toBe(200);

    db.close();
  });

  test("graceful close", async () => {
    const db = new BunQL(dbPath);
    db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");

    for (let i = 0; i < 10; i++) {
      db.run("INSERT INTO test (val) VALUES (?)", [`val-${i}`]);
    }

    await db.close();
    expect(db.closed).toBe(true);
  });

  test("mixed read/write operations", () => {
    const db = new BunQL(dbPath);
    db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");

    for (let i = 0; i < 50; i++) {
      db.run("INSERT INTO test (val) VALUES (?)", [`write-${i}`]);
      if (i % 2 === 0) {
        db.query("SELECT COUNT(*) as cnt FROM test");
      }
    }

    const final = db.query<{ cnt: number }>("SELECT COUNT(*) as cnt FROM test");
    expect(final.rows[0]?.cnt).toBe(50);

    db.close();
  });

  test("rapid sequential write cycles", () => {
    const db = new BunQL(dbPath);
    db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");

    for (let round = 0; round < 10; round++) {
      for (let i = 0; i < 10; i++) {
        db.run("INSERT INTO test (val) VALUES (?)", [`round-${round}-item-${i}`]);
      }
    }

    const count = db.query<{ cnt: number }>("SELECT COUNT(*) as cnt FROM test");
    expect(count.rows[0]?.cnt).toBe(100);

    db.close();
  });

  test("statement cache cleanup on close", async () => {
    const db = new BunQL(dbPath);
    db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");

    for (let i = 0; i < 10; i++) {
      db.query(`SELECT ${i} AS val`);
    }

    await db.close();
    expect(db.closed).toBe(true);
  });

  test("long-running sequential stability", () => {
    const db = new BunQL(dbPath);
    db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");

    for (let i = 0; i < 500; i++) {
      db.run("INSERT INTO test (val) VALUES (?)", [`seq-${i}`]);
    }

    const count = db.query<{ cnt: number }>("SELECT COUNT(*) as cnt FROM test");
    expect(count.rows[0]?.cnt).toBe(500);

    db.close();
  });

  test("transaction storm with mixed operations", async () => {
    const db = new BunQL(dbPath);
    db.run("CREATE TABLE account (id INTEGER PRIMARY KEY, balance INTEGER)");
    db.run("INSERT INTO account VALUES (1, 1000)");
    db.run("INSERT INTO account VALUES (2, 0)");

    const txs = Array.from({ length: 50 }, () =>
      db.transaction(async (tx) => {
        const from = tx.query<{ balance: number }>(
          "SELECT balance FROM account WHERE id = 1",
        );
        const amount = 10;
        const currentFrom = from[0]?.balance ?? 0;

        if (currentFrom >= amount) {
          tx.run("UPDATE account SET balance = balance - ? WHERE id = 1", [amount]);
          tx.run("UPDATE account SET balance = balance + ? WHERE id = 2", [amount]);
        }
        return 1;
      }),
    );

    const results = await Promise.all(txs);
    expect(results).toHaveLength(50);

    const balances = db.query<{ balance: number }>(
      "SELECT balance FROM account ORDER BY id",
    );
    const total = (balances.rows[0]?.balance ?? 0) + (balances.rows[1]?.balance ?? 0);
    expect(total).toBe(1000);

    db.close();
  });

  test("stress: interleaved read/write/transaction storm", async () => {
    const db = new BunQL(dbPath);
    db.run("CREATE TABLE stress (id INTEGER PRIMARY KEY, val TEXT)");

    for (let i = 0; i < 30; i++) {
      db.run("INSERT INTO stress (val) VALUES (?)", [`write-${i}`]);
    }

    const reads = db.query<{ cnt: number }>("SELECT COUNT(*) as cnt FROM stress");
    expect(reads.rows[0]?.cnt).toBe(30);

    const txs = Array.from({ length: 10 }, () =>
      db.transaction(async (tx) => {
        tx.query("SELECT COUNT(*) as cnt FROM stress");
      }),
    );
    await Promise.all(txs);

    const final = db.query<{ cnt: number }>("SELECT COUNT(*) as cnt FROM stress");
    expect(final.rows[0]?.cnt).toBe(30);

    db.close();
  });
});
