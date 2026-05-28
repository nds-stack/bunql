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

  test("onDrain is called when queue empties after transaction", async () => {
    let drained = false;

    const db = new BunQL(dbPath, {
      events: {
        onDrain: () => {
          drained = true;
        },
      },
    });

    db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)");

    await db.transaction(async (tx) => {
      tx.run("INSERT INTO test (value) VALUES (?)", ["a"]);
    });

    expect(drained).toBe(true);

    db.close();
  });

  test("transaction hooks are called", async () => {
    const calls: string[] = [];

    const db = new BunQL(dbPath, {
      hooks: {
        beforeTransaction: () => calls.push("before_tx"),
        afterTransaction: () => calls.push("after_tx"),
      },
    });

    db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)");
    await db.transaction(async (tx) => {
      tx.run("INSERT INTO test (value) VALUES (?)", ["x"]);
    });

    expect(calls).toContain("before_tx");
    expect(calls).toContain("after_tx");

    db.close();
  });

  test("logger receives debug messages", () => {
    const logs: string[] = [];

    const db = new BunQL(dbPath, {
      logger: {
        error: () => {},
        warn: () => {},
        info: (msg: string) => logs.push(msg),
        debug: (msg: string) => logs.push(msg),
      },
    });

    db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)");

    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some((l) => l.includes("Database opened"))).toBe(true);

    db.close();
  });

  test("onError is called when transaction fails", async () => {
    const errors: Error[] = [];

    const db = new BunQL(dbPath, {
      events: {
        onError: (err) => errors.push(err),
      },
    });

    try {
      await db.exec("INVALID SQL");
    } catch {
      // expected
    }

    expect(errors.length).toBeGreaterThanOrEqual(1);

    db.close();
  });

  test("run throws directly on SQL error (no onError wrapping)", () => {
    const errors: Error[] = [];

    const db = new BunQL(dbPath, {
      events: {
        onError: (err) => errors.push(err),
      },
    });

    expect(() => db.run("INVALID SQL")).toThrow();
    expect(errors.length).toBe(0);

    db.close();
  });
});
