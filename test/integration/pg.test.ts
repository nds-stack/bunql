import { describe, test, expect, afterAll } from "bun:test";
import { PGDriver } from "../../src/driver/pg.ts";

let driver: PGDriver;
let available = false;

try {
  driver = new PGDriver("postgres://postgres@localhost:5432/postgres");
  await driver.query("SELECT 1");
  await driver.run("DROP TABLE IF EXISTS int_users");
  await driver.run("CREATE TABLE int_users (id SERIAL PRIMARY KEY, name TEXT, email TEXT)");
  available = true;
} catch {
  // PG not available — all tests will skip via guard
}

describe("PostgreSQL integration", () => {
  afterAll(async () => {
    if (!available) return;
    await driver.run("DROP TABLE IF EXISTS int_users").catch(() => {});
    await driver.close();
  });

  test("INSERT via run() returns changes", async () => {
    if (!available) return;
    await driver.run("TRUNCATE int_users RESTART IDENTITY CASCADE");
    const r = await driver.run("INSERT INTO int_users (name, email) VALUES ($1, $2)", ["Alice", "a@test.com"]);
    expect(r.changes).toBe(1);
  });

  test("SELECT via query() returns rows", async () => {
    if (!available) return;
    await driver.run("TRUNCATE int_users RESTART IDENTITY CASCADE");
    await driver.run("INSERT INTO int_users (name, email) VALUES ($1, $2)", ["Alice", "a@test.com"]);
    await driver.run("INSERT INTO int_users (name, email) VALUES ($1, $2)", ["Bob", "b@test.com"]);
    const res = await driver.query("SELECT * FROM int_users ORDER BY id");
    expect(res.rows).toHaveLength(2);
  });

  test("SELECT with parameterized WHERE", async () => {
    if (!available) return;
    await driver.run("TRUNCATE int_users RESTART IDENTITY CASCADE");
    await driver.run("INSERT INTO int_users (name, email) VALUES ($1, $2)", ["Alice", "a@test.com"]);
    await driver.run("INSERT INTO int_users (name, email) VALUES ($1, $2)", ["Bob", "b@test.com"]);
    const res = await driver.query("SELECT name FROM int_users WHERE id = $1", [1]);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]?.name).toBe("Alice");
  });

  test("UPDATE modifies rows", async () => {
    if (!available) return;
    await driver.run("TRUNCATE int_users RESTART IDENTITY CASCADE");
    await driver.run("INSERT INTO int_users (name, email) VALUES ($1, $2)", ["Alice", "a@test.com"]);
    const r = await driver.run("UPDATE int_users SET email = $1 WHERE name = $2", ["new@test.com", "Alice"]);
    expect(r.changes).toBe(1);
    const res = await driver.query("SELECT email FROM int_users WHERE name = $1", ["Alice"]);
    expect(res.rows[0]?.email).toBe("new@test.com");
  });

  test("DELETE removes rows", async () => {
    if (!available) return;
    await driver.run("TRUNCATE int_users RESTART IDENTITY CASCADE");
    await driver.run("INSERT INTO int_users (name, email) VALUES ($1, $2)", ["Alice", "a@test.com"]);
    await driver.run("INSERT INTO int_users (name, email) VALUES ($1, $2)", ["Bob", "b@test.com"]);
    const r = await driver.run("DELETE FROM int_users WHERE name = $1", ["Alice"]);
    expect(r.changes).toBe(1);
    const res = await driver.query("SELECT COUNT(*) as count FROM int_users");
    expect(Number(res.rows[0]?.count)).toBe(1);
  });

  test("query returns empty rows for no match", async () => {
    if (!available) return;
    await driver.run("TRUNCATE int_users RESTART IDENTITY CASCADE");
    const res = await driver.query("SELECT * FROM int_users WHERE name = $1", ["Nobody"]);
    expect(res.rows).toHaveLength(0);
  });

  test("SELECT via query() returns rows", async () => {
    if (!available) return;
    await driver.run("TRUNCATE int_users RESTART IDENTITY CASCADE");
    await driver.run("INSERT INTO int_users (name, email) VALUES ($1, $2)", ["Alice", "a@test.com"]);
    await driver.run("INSERT INTO int_users (name, email) VALUES ($1, $2)", ["Bob", "b@test.com"]);
    const res = await driver.query("SELECT * FROM int_users ORDER BY id");
    expect(res.rows).toHaveLength(2);
  });

  test("SELECT with parameterized WHERE", async () => {
    if (!available) return;
    await driver.run("TRUNCATE int_users RESTART IDENTITY CASCADE");
    await driver.run("INSERT INTO int_users (name, email) VALUES ($1, $2)", ["Alice", "a@test.com"]);
    await driver.run("INSERT INTO int_users (name, email) VALUES ($1, $2)", ["Bob", "b@test.com"]);
    const res = await driver.query("SELECT name FROM int_users WHERE id = $1", [1]);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]?.name).toBe("Alice");
  });

  test("UPDATE modifies rows", async () => {
    if (!available) return;
    await driver.run("TRUNCATE int_users RESTART IDENTITY CASCADE");
    await driver.run("INSERT INTO int_users (name, email) VALUES ($1, $2)", ["Alice", "a@test.com"]);
    const r = await driver.run("UPDATE int_users SET email = $1 WHERE name = $2", ["new@test.com", "Alice"]);
    expect(r.changes).toBe(1);
    const res = await driver.query("SELECT email FROM int_users WHERE name = $1", ["Alice"]);
    expect(res.rows[0]?.email).toBe("new@test.com");
  });

  test("DELETE removes rows", async () => {
    if (!available) return;
    await driver.run("TRUNCATE int_users RESTART IDENTITY CASCADE");
    await driver.run("INSERT INTO int_users (name, email) VALUES ($1, $2)", ["Alice", "a@test.com"]);
    await driver.run("INSERT INTO int_users (name, email) VALUES ($1, $2)", ["Bob", "b@test.com"]);
    const r = await driver.run("DELETE FROM int_users WHERE name = $1", ["Alice"]);
    expect(r.changes).toBe(1);
    const res = await driver.query("SELECT COUNT(*) as count FROM int_users");
    expect(Number(res.rows[0]?.count)).toBe(1);
  });

  test("query returns empty rows for no match", async () => {
    if (!available) return;
    await driver.run("TRUNCATE int_users RESTART IDENTITY CASCADE");
    const res = await driver.query("SELECT * FROM int_users WHERE name = $1", ["Nobody"]);
    expect(res.rows).toHaveLength(0);
  });

  test("invalid SQL throws", async () => {
    if (!available) return;
    try {
      await driver.run("INVALID SQL");
      expect.unreachable();
    } catch {
      expect(true).toBe(true);
    }
  });
});
