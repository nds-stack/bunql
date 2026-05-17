import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { BunQL } from "../src/bunql.ts";
import { getTestDBPath } from "./helpers/setup.ts";
import { unlinkSync } from "fs";

describe("Events", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = getTestDBPath("events");
  });

  afterEach(() => {
    try {
      unlinkSync(dbPath);
    } catch {
      // file may already be deleted
    }
  });

  test("onBusy is called when SQLITE_BUSY occurs", async () => {
    const busyCalls: { attempt: number; delay: number }[] = [];
    const retryCalls: { attempt: number; delay: number }[] = [];

    const db = new BunQL(dbPath, {
      busyTimeout: 1,
      retry: { maxRetries: 2, baseDelay: 1, maxDelay: 5, jitter: false },
      events: {
        onBusy: (attempt, delay) => {
          busyCalls.push({ attempt, delay });
        },
        onRetry: (attempt, delay) => {
          retryCalls.push({ attempt, delay });
        },
      },
    });

    // Prepare table via bunql
    await db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)");

    // Open separate connection and hold a RESERVED lock
    const { Database } = await import("bun:sqlite");
    const rawDb = new Database(dbPath);
    rawDb.run("BEGIN IMMEDIATE");
    rawDb.run("INSERT INTO test VALUES (1, 'locked')");
    // Lock remains held — no COMMIT/ROLLBACK yet

    // This write will hit SQLITE_BUSY because rawDb holds RESERVED lock
    // RetryPolicy should retry (and fail) because rawDb still holds the lock
    try {
      await db.run("INSERT INTO test VALUES (2, 'should-retry')");
    } catch {
      // BusyError expected after retry exhaustion
    }

    // Release lock
    rawDb.run("ROLLBACK");

    expect(busyCalls.length).toBeGreaterThan(0);
    expect(retryCalls.length).toBeGreaterThan(0);

    rawDb.close();
    db.close();
  });

  test("onDrain is called when queue empties", async () => {
    let drained = false;

    const db = new BunQL(dbPath, {
      events: {
        onDrain: () => {
          drained = true;
        },
      },
    });

    await db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)");
    await db.run("INSERT INTO test VALUES (1, 'a')");
    await db.run("INSERT INTO test VALUES (2, 'b')");

    // After all operations complete, onDrain should have been called
    expect(drained).toBe(true);

    db.close();
  });

  test("hooks are called during write operations", async () => {
    const calls: string[] = [];

    const db = new BunQL(dbPath, {
      hooks: {
        beforeWrite: () => calls.push("before"),
        afterWrite: () => calls.push("after"),
      },
    });

    await db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)");

    expect(calls).toContain("before");
    expect(calls).toContain("after");

    db.close();
  });

  test("hooks are called during transaction", async () => {
    const calls: string[] = [];

    const db = new BunQL(dbPath, {
      hooks: {
        beforeTransaction: () => calls.push("before_tx"),
        afterTransaction: () => calls.push("after_tx"),
      },
    });

    await db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)");
    await db.transaction(async (tx) => {
      await tx.run("INSERT INTO test (value) VALUES (?)", ["x"]);
    });

    expect(calls).toContain("before_tx");
    expect(calls).toContain("after_tx");

    db.close();
  });

  test("logger receives debug messages", async () => {
    const logs: string[] = [];

    const db = new BunQL(dbPath, {
      logger: {
        error: () => {},
        warn: () => {},
        info: (msg: string) => logs.push(msg),
        debug: (msg: string) => logs.push(msg),
      },
    });

    await db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)");

    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some((l) => l.includes("Database opened"))).toBe(true);

    db.close();
  });

  test("onError is called via event handler on write failure", async () => {
    const errors: Error[] = [];

    const db = new BunQL(dbPath, {
      events: {
        onError: (err) => errors.push(err),
      },
    });

    await db.run("CREATE TABLE test (id INTEGER PRIMARY KEY)");

    try {
      await db.run("INVALID SQL STATEMENT");
    } catch {
      // expected
    }

    expect(errors.length).toBeGreaterThanOrEqual(1);

    db.close();
  });
});
