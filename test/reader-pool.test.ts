import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { BunQL } from "../src/bunql.ts";
import { getTestDBPath } from "./helpers/setup.ts";
import { unlinkSync } from "fs";

describe("ReaderPool", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = getTestDBPath("reader-pool");
  });

  afterEach(() => {
    try { unlinkSync(dbPath); } catch { /* cleanup */ }
  });

  test("reader pool processes reads in parallel", async () => {
    const db = new BunQL(dbPath, { readerPool: 3 });
    await db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");

    const reads = Array.from({ length: 30 }, (_, i) =>
      db.query("SELECT ? AS val", [i]),
    );

    for (const result of reads) {
      expect(result.rows.length).toBe(1);
    }
    db.close();
  });

  test("reader pool does not affect writes", async () => {
    const db = new BunQL(dbPath, { readerPool: 2 });
    await db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");

    const writes = Array.from({ length: 10 }, (_, i) =>
      db.run("INSERT INTO test (val) VALUES (?)", [`val-${i}`]),
    );
    await Promise.all(writes);

    const count = db.query<{ cnt: number }>("SELECT COUNT(*) as cnt FROM test");
    expect(count.rows[0]?.cnt).toBe(10);
    db.close();
  });

  test("reader pool size 0 falls back to main db", () => {
    const db = new BunQL(dbPath);
    const result = db.query("SELECT 1 AS val");
    expect(result.rows[0]?.val).toBe(1);
    db.close();
  });
});
