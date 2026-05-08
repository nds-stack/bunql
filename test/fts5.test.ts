import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { BunQL } from "../src/bunql.ts";
import { getTestDBPath } from "./helpers/setup.ts";
import { unlinkSync } from "fs";

describe("FTS5", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = getTestDBPath("fts5");
  });

  afterEach(() => {
    try { unlinkSync(dbPath); } catch { /* cleanup */ }
  });

  test("fts.create sets up virtual table", async () => {
    const db = new BunQL(dbPath);

    await db.fts.create("articles", ["title", "body"]);

    const tables = db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='articles'",
    );
    expect(tables.rows.length).toBe(1);
    db.close();
  });

  test("fts.insert and fts.search round-trip", async () => {
    const db = new BunQL(dbPath);
    await db.fts.create("articles", ["title", "body"]);

    await db.fts.insert("articles", { title: "Hello World", body: "This is a test article" });
    await db.fts.insert("articles", { title: "SQLite FTS", body: "Full text search in SQLite" });

    const results = db.fts.search("articles", "test");
    expect(results.length).toBe(1);
    expect((results[0] as Record<string, unknown>).title).toBe("Hello World");
    db.close();
  });

  test("fts.update modifies existing row", async () => {
    const db = new BunQL(dbPath);
    await db.fts.create("articles", ["title", "body"]);

    await db.fts.insert("articles", { title: "Original", body: "Original body" });
    const before = db.fts.search("articles", "Original");
    const id = (before[0] as Record<string, unknown>).rowid as number;

    await db.fts.update("articles", id, { title: "Updated" });

    const after = db.fts.search("articles", "Updated");
    expect(after.length).toBe(1);
    db.close();
  });

  test("fts.delete removes row from index", async () => {
    const db = new BunQL(dbPath);
    await db.fts.create("articles", ["title", "body"]);

    await db.fts.insert("articles", { title: "To Delete", body: "Will be removed" });
    const results = db.fts.search("articles", "Delete");
    expect(results.length).toBe(1);

    const id = (results[0] as Record<string, unknown>).rowid as number;
    await db.fts.delete("articles", id);

    const after = db.fts.search("articles", "Delete");
    expect(after.length).toBe(0);
    db.close();
  });

  test("fts.search with snippet option", async () => {
    const db = new BunQL(dbPath);
    await db.fts.create("articles", ["title", "body"]);

    await db.fts.insert("articles", { title: "Long Article", body: "This is a very long article about SQLite full text search engine" });

    const results = db.fts.search("articles", "search", { snippet: true });
    expect(results.length).toBe(1);
    const row = results[0] as Record<string, unknown>;
    expect(row.snippet).toBeDefined();
    db.close();
  });

  test("fts.drop removes the virtual table", async () => {
    const db = new BunQL(dbPath);
    await db.fts.create("articles", ["title", "body"]);
    await db.fts.drop("articles");

    const tables = db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='articles'",
    );
    expect(tables.rows.length).toBe(0);
    db.close();
  });
});
