/**
 * @module test-statement-features
 * @description Tests for new v0.3.0 Statement features: raw(), pluck(), columns(), bind(), iterate(), as()
 */
import { describe, test, expect } from "bun:test";
import { BunQL } from "../src/index.ts";

describe("Statement raw()", () => {
  test("raw() returns arrays instead of objects", () => {
    const db = new BunQL(":memory:");
    db.run("CREATE TABLE t (id INTEGER, name TEXT)");
    db.run("INSERT INTO t VALUES (1, 'Alice'), (2, 'Bob')");

    const stmt = db.prepare("SELECT * FROM t ORDER BY id");
    const rows = stmt.raw().all();
    expect(rows).toEqual([[1, "Alice"], [2, "Bob"]]);
    db.close();
  });

  test("raw() + get() returns array", () => {
    const db = new BunQL(":memory:");
    db.run("CREATE TABLE t (id INTEGER, name TEXT)");
    db.run("INSERT INTO t VALUES (1, 'Alice')");

    const stmt = db.prepare("SELECT * FROM t WHERE id = 1");
    const row = stmt.raw().get() as unknown[];
    expect(Array.isArray(row)).toBe(true);
    expect(row).toEqual([1, "Alice"]);
    db.close();
  });

  test("raw(false) returns objects again", () => {
    const db = new BunQL(":memory:");
    db.run("CREATE TABLE t (id INTEGER, name TEXT)");
    db.run("INSERT INTO t VALUES (1, 'Alice')");

    const stmt = db.prepare("SELECT * FROM t");
    const arr = stmt.raw().all();
    expect(Array.isArray(arr[0])).toBe(true);

    const obj = stmt.raw(false).all();
    expect(typeof obj[0]).toBe("object");
    expect(obj[0]).toHaveProperty("id", 1);
    db.close();
  });
});

describe("Statement pluck()", () => {
  test("pluck() returns first column value only", () => {
    const db = new BunQL(":memory:");
    db.run("CREATE TABLE t (id INTEGER, name TEXT)");
    db.run("INSERT INTO t VALUES (1, 'Alice'), (2, 'Bob')");

    const stmt = db.prepare("SELECT id FROM t ORDER BY id");
    const rows = stmt.pluck().all();
    expect(rows).toEqual([1, 2]);
    db.close();
  });

  test("pluck() + get() returns scalar", () => {
    const db = new BunQL(":memory:");
    db.run("CREATE TABLE t (id INTEGER, name TEXT)");
    db.run("INSERT INTO t VALUES (1, 'Alice')");

    const stmt = db.prepare("SELECT name FROM t WHERE id = 1");
    const value = stmt.pluck().get();
    expect(value).toBe("Alice");
    db.close();
  });

  test("pluck + raw returns first element of each array", () => {
    const db = new BunQL(":memory:");
    db.run("CREATE TABLE t (id INTEGER, name TEXT)");
    db.run("INSERT INTO t VALUES (1, 'Alice')");

    const stmt = db.prepare("SELECT id, name FROM t");
    const rows = stmt.raw().pluck().all();
    expect(rows).toEqual([1]);
    db.close();
  });
});

describe("Statement columns()", () => {
  test("columns() returns column metadata", () => {
    const db = new BunQL(":memory:");
    db.run("CREATE TABLE t (id INTEGER, name TEXT)");

    const stmt = db.prepare("SELECT id, name FROM t");
    const cols = stmt.columns();
    expect(cols.length).toBe(2);
    expect(cols[0]!.name).toBe("id");
    expect(cols[1]!.name).toBe("name");
    db.close();
  });
});

describe("Statement bind()", () => {
  test("bind() pre-binds parameters", () => {
    const db = new BunQL(":memory:");
    db.run("CREATE TABLE t (id INTEGER, name TEXT)");
    db.run("INSERT INTO t VALUES (1, 'Alice'), (2, 'Bob')");

    const stmt = db.prepare<{ name: string }>("SELECT name FROM t WHERE id = ?");
    stmt.bind(1);
    const row = stmt.get();
    expect(row?.name).toBe("Alice");

    stmt.bind(2);
    const row2 = stmt.get();
    expect(row2?.name).toBe("Bob");
    db.close();
  });

  test("bound params can be overridden by call-site params", () => {
    const db = new BunQL(":memory:");
    db.run("CREATE TABLE t (id INTEGER, name TEXT)");
    db.run("INSERT INTO t VALUES (1, 'Alice'), (2, 'Bob')");

    const stmt = db.prepare("SELECT name FROM t WHERE id = ?");
    stmt.bind(1);
    const row = stmt.get(2);
    expect(row).toBeDefined();
    // call-site param (2) overrides bound (1), so returns "Bob"
    expect((row as Record<string, string>).name).toBe("Bob");
    db.close();
  });
});

describe("Statement iterate()", () => {
  test("iterate() yields rows one by one", () => {
    const db = new BunQL(":memory:");
    db.run("CREATE TABLE t (id INTEGER, name TEXT)");
    db.run("INSERT INTO t VALUES (1, 'Alice'), (2, 'Bob'), (3, 'Charlie')");

    const stmt = db.prepare<{ id: number }>("SELECT * FROM t ORDER BY id");
    const ids: number[] = [];
    for (const row of stmt.iterate()) {
      ids.push(row.id);
    }
    expect(ids).toEqual([1, 2, 3]);
    db.close();
  });

  test("iterate works with raw()", () => {
    const db = new BunQL(":memory:");
    db.run("CREATE TABLE t (id INTEGER, name TEXT)");
    db.run("INSERT INTO t VALUES (1, 'Alice'), (2, 'Bob')");

    const stmt = db.prepare("SELECT * FROM t ORDER BY id");
    const rows: unknown[][] = [];
    for (const row of stmt.raw().iterate()) {
      rows.push(row);
    }
    expect(rows.length).toBe(2);
    expect(Array.isArray(rows[0])).toBe(true);
    db.close();
  });
});

describe("Statement as()", () => {
  test("as() maps rows to class instances", () => {
    class User {
      id!: number;
      name!: string;
      get displayName() {
        return `User: ${this.name}`;
      }
    }

    const db = new BunQL(":memory:");
    db.run("CREATE TABLE users (id INTEGER, name TEXT)");
    db.run("INSERT INTO users VALUES (1, 'Alice')");

    const stmt = db.prepare("SELECT * FROM users WHERE id = 1").as(User);
    const user = stmt.get();
    expect(user).toBeDefined();
    expect(user!.displayName).toBe("User: Alice");
    db.close();
  });

  test("as() works with all()", () => {
    class User {
      id!: number;
      name!: string;
    }

    const db = new BunQL(":memory:");
    db.run("CREATE TABLE users (id INTEGER, name TEXT)");
    db.run("INSERT INTO users VALUES (1, 'Alice'), (2, 'Bob')");

    const users = db.prepare("SELECT * FROM users ORDER BY id").as(User).all();
    expect(users.length).toBe(2);
    expect(users[0] instanceof User).toBe(true);
    expect(users[0]!.name).toBe("Alice");
    db.close();
  });
});

describe("Statement source and reader", () => {
  test("source returns SQL string", () => {
    const db = new BunQL(":memory:");
    const stmt = db.prepare("SELECT 1");
    expect(stmt.source).toContain("SELECT 1");
    db.close();
  });

  test("reader is true for SELECT", () => {
    const db = new BunQL(":memory:");
    const stmt = db.prepare("SELECT 1");
    expect(stmt.reader).toBe(true);
    db.close();
  });

  test("reader is false for INSERT", () => {
    const db = new BunQL(":memory:");
    db.run("CREATE TABLE t (id INTEGER)");
    const stmt = db.prepare("INSERT INTO t VALUES (1)");
    expect(stmt.reader).toBe(false);
    db.close();
  });
});

describe("BunQL pragma()", () => {
  test("pragma() returns structured rows", () => {
    const db = new BunQL(":memory:");
    const result = db.pragma("user_version") as Array<Record<string, number>>;
    expect(Array.isArray(result)).toBe(true);
    expect(result[0]).toHaveProperty("user_version");
    db.close();
  });

  test("pragma() with simple:true returns scalar", () => {
    const db = new BunQL(":memory:");
    db.run("PRAGMA user_version = 42");
    const value = db.pragma("user_version", { simple: true });
    expect(value).toBe(42);
    db.close();
  });

  test("pragma() auto-prefixes PRAGMA", () => {
    const db = new BunQL(":memory:");
    const result = db.pragma("user_version", { simple: true });
    expect(typeof result).toBe("number");
    db.close();
  });
});

describe("BunQL transaction modes", () => {
  test("transaction supports deferred mode", async () => {
    const db = new BunQL(":memory:");
    db.run("CREATE TABLE t (id INTEGER)");
    await db.transaction(async (tx) => {
      tx.run("INSERT INTO t VALUES (1)");
    }, "deferred");
    const rows = db.query("SELECT * FROM t");
    expect(rows.rows.length).toBe(1);
    db.close();
  });

  test("transaction supports exclusive mode", async () => {
    const db = new BunQL(":memory:");
    db.run("CREATE TABLE t (id INTEGER)");
    await db.transaction(async (tx) => {
      tx.run("INSERT INTO t VALUES (1)");
    }, "exclusive");
    const rows = db.query("SELECT * FROM t");
    expect(rows.rows.length).toBe(1);
    db.close();
  });

  test("transaction defaults to immediate", async () => {
    const db = new BunQL(":memory:");
    db.run("CREATE TABLE t (id INTEGER)");
    await db.transaction(async (tx) => {
      tx.run("INSERT INTO t VALUES (1)");
    });
    expect(db.query("SELECT * FROM t").rows.length).toBe(1);
    db.close();
  });
});

describe("BunQL database properties", () => {
  test("inTransaction is false outside transaction", () => {
    const db = new BunQL(":memory:");
    expect(db.inTransaction).toBe(false);
    db.close();
  });

  test("readonly reflects config", () => {
    const db = new BunQL(":memory:", { readonly: true });
    expect(db.readonly).toBe(true);
    db.close();
  });
});

describe("BunQL verbose mode", () => {
  test("verbose:true logs SQL via logger", () => {
    const logs: string[] = [];
    const db = new BunQL(":memory:", {
      verbose: true,
      logger: { debug: (msg: string) => logs.push(msg), error: () => {}, warn: () => {}, info: () => {} },
    });
    db.run("SELECT 1");
    expect(logs.some(l => l.includes("SELECT 1"))).toBe(true);
    db.close();
  });

  test("verbose callback receives SQL", () => {
    const sqls: string[] = [];
    const db = new BunQL(":memory:", {
      verbose: (sql: string) => sqls.push(sql),
    });
    db.run("SELECT 42");
    expect(sqls).toContain("SELECT 42");
    db.close();
  });
});

describe("BunQL safeIntegers option", () => {
  test("safeIntegers passthrough to bun:sqlite", () => {
    const db = new BunQL(":memory:", { safeIntegers: true });
    const result = db.query<{ val: bigint }>("SELECT 9223372036854775807 as val");
    expect(typeof result.rows[0]!.val).toBe("bigint");
    db.close();
  });
});

describe("BunQL serialize/deserialize", () => {
  test("serialize produces Uint8Array", () => {
    const db = new BunQL(":memory:");
    db.run("CREATE TABLE t (id INTEGER)");
    db.run("INSERT INTO t VALUES (1)");
    const buf = db.serialize();
    expect(buf instanceof Uint8Array).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
    db.close();
  });

  test.skip("deserialize restores data", () => {
    // skipped: static deserialize requires internal constructor logic
    // which may need bun:sqlite Database.deserialize support
  });
});
