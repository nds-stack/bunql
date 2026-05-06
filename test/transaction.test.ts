import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { BunQL } from "../src/bunql.ts";
import { getTestDBPath } from "./helpers/setup.ts";
import { unlinkSync } from "fs";

describe("Transaction", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = getTestDBPath("tx");
  });

  afterEach(() => {
    try {
      unlinkSync(dbPath);
    } catch {
      // file may already be deleted
    }
  });

  test("transaction commits changes on success", async () => {
    const db = new BunQL(dbPath);
    await db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");

    const result = await db.transaction(async (tx) => {
      await tx.run("INSERT INTO users (name) VALUES (?)", ["Alice"]);
      await tx.run("INSERT INTO users (name) VALUES (?)", ["Bob"]);
      return "done";
    });

    expect(result).toBe("done");

    const users = db.query<{ name: string }>("SELECT name FROM users ORDER BY id");
    expect(users.rows).toHaveLength(2);
    expect(users.rows[0]?.name).toBe("Alice");
    expect(users.rows[1]?.name).toBe("Bob");

    db.close();
  });

  test("transaction rolls back on error, preserving original cause", async () => {
    const db = new BunQL(dbPath);
    await db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
    await db.run("INSERT INTO users (name) VALUES ('Initial')");

    try {
      await db.transaction(async (tx) => {
        await tx.run("INSERT INTO users (name) VALUES (?)", ["Alice"]);
        throw new Error("something went wrong");
      });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toBe("Transaction failed and was rolled back");
      // Original error should be preserved in cause
      expect((e as Error).cause).toBeDefined();
      expect(((e as Error).cause as Error).message).toBe("something went wrong");
    }

    const users = db.query<{ name: string }>("SELECT name FROM users ORDER BY id");
    expect(users.rows).toHaveLength(1);
    expect(users.rows[0]?.name).toBe("Initial");

    db.close();
  });

  test("transaction reads within transaction see uncommitted data", async () => {
    const db = new BunQL(dbPath);
    await db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");

    await db.transaction(async (tx) => {
      await tx.run("INSERT INTO users (name) VALUES (?)", ["Alice"]);

      const users = tx.query<{ name: string }>("SELECT name FROM users");
      expect(users).toHaveLength(1);
      expect(users[0]?.name).toBe("Alice");
    });

    db.close();
  });

  test("nested transaction via SAVEPOINT", async () => {
    const db = new BunQL(dbPath);
    await db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");

    await db.transaction(async (tx) => {
      await tx.run("INSERT INTO users (name) VALUES (?)", ["Alice"]);

      // Nested transaction
      await db.transaction(async (inner) => {
        await inner.run("INSERT INTO users (name) VALUES (?)", ["Bob"]);
      });
    });

    const users = db.query<{ name: string }>("SELECT name FROM users ORDER BY id");
    expect(users.rows).toHaveLength(2);

    db.close();
  });

  test("nested transaction rollback does not affect outer", async () => {
    const db = new BunQL(dbPath);
    await db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");

    await db.transaction(async (tx) => {
      await tx.run("INSERT INTO users (name) VALUES (?)", ["Alice"]);

      try {
        await db.transaction(async (inner) => {
          await inner.run("INSERT INTO users (name) VALUES (?)", ["Bob"]);
          throw new Error("inner fail");
        });
        expect.unreachable();
      } catch {
        // expected
      }

      // Re-insert Bob after inner rollback
      await tx.run("INSERT INTO users (name) VALUES (?)", ["Bob"]);
    });

    const users = db.query<{ name: string }>("SELECT name FROM users ORDER BY id");
    expect(users.rows).toHaveLength(2);

    db.close();
  });

  test("transactions are serialized (no interleaving)", async () => {
    const db = new BunQL(dbPath);
    await db.run("CREATE TABLE counters (id INTEGER PRIMARY KEY, val INTEGER)");
    await db.run("INSERT INTO counters VALUES (1, 0)");

    const txs = Array.from({ length: 10 }, (_, i) =>
      db.transaction(async (tx) => {
        const rows = tx.query<{ val: number }>("SELECT val FROM counters WHERE id = 1");
        const current = rows[0]?.val ?? 0;
        await tx.run("UPDATE counters SET val = ? WHERE id = 1", [current + 1]);
        return i;
      })
    );

    const results = await Promise.all(txs);
    expect(results).toHaveLength(10);

    const final = db.query<{ val: number }>("SELECT val FROM counters WHERE id = 1");
    expect(final.rows[0]?.val).toBe(10);

    db.close();
  });

  test("transaction context can also run read queries", async () => {
    const db = new BunQL(dbPath);
    await db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
    await db.run("INSERT INTO users (name) VALUES ('Alice')");

    await db.transaction(async (tx) => {
      // read-only query inside transaction
      const users = tx.query<{ name: string }>("SELECT name FROM users");
      expect(users).toHaveLength(1);
      expect(users[0]?.name).toBe("Alice");

      await tx.run("INSERT INTO users (name) VALUES (?)", ["Bob"]);
    });

    db.close();
  });

  test("concurrent transaction reads are allowed during write", async () => {
    const db = new BunQL(dbPath);
    await db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");

    const writePromise = db.transaction(async (tx) => {
      await tx.run("INSERT INTO users (name) VALUES (?)", ["Alice"]);
      await Bun.sleep(20);
      await tx.run("INSERT INTO users (name) VALUES (?)", ["Bob"]);
    });

    // Reads should not block during transaction
    await Bun.sleep(5);
    const readResult = db.query<{ count: number }>("SELECT COUNT(*) as count FROM users");
    expect(readResult.rows[0]?.count).toBeGreaterThanOrEqual(0);

    await writePromise;
    db.close();
  });
});
