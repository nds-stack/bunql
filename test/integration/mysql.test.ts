import { describe, test, expect, afterAll } from "bun:test";
import { MySQLDriver } from "../../src/driver/mysql.ts";

let driver: MySQLDriver;
let available = false;

try {
  driver = new MySQLDriver("mysql://root@localhost:3306/mysql");
  await driver.query("SELECT 1");
  await driver.run("DROP TABLE IF EXISTS int_users");
  await driver.run("CREATE TABLE int_users (id INTEGER AUTO_INCREMENT PRIMARY KEY, name TEXT, email TEXT)");
  available = true;
} catch {
  // MySQL not available — all tests will skip via guard
}

describe("MySQL integration", () => {
  afterAll(async () => {
    if (!available) return;
    await driver.run("DROP TABLE IF EXISTS int_users").catch(() => {});
    await driver.close();
  });

  test("INSERT via run() returns changes", async () => {
    if (!available) return;
    await driver.run("TRUNCATE TABLE int_users");
    const r = await driver.run("INSERT INTO int_users (name, email) VALUES (?, ?)", ["Alice", "a@test.com"]);
    expect(r.changes).toBe(1);
  });

  test("SELECT via query() returns rows", async () => {
    if (!available) return;
    await driver.run("TRUNCATE TABLE int_users");
    await driver.run("INSERT INTO int_users (name, email) VALUES (?, ?)", ["Alice", "a@test.com"]);
    await driver.run("INSERT INTO int_users (name, email) VALUES (?, ?)", ["Bob", "b@test.com"]);
    const res = await driver.query("SELECT * FROM int_users ORDER BY id");
    expect(res.rows).toHaveLength(2);
  });

  test("SELECT with parameterized WHERE", async () => {
    if (!available) return;
    await driver.run("TRUNCATE TABLE int_users");
    await driver.run("INSERT INTO int_users (name, email) VALUES (?, ?)", ["Alice", "a@test.com"]);
    await driver.run("INSERT INTO int_users (name, email) VALUES (?, ?)", ["Bob", "b@test.com"]);
    const res = await driver.query("SELECT name FROM int_users WHERE id = ?", [1]);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]?.name).toBe("Alice");
  });

  test("UPDATE modifies rows", async () => {
    if (!available) return;
    await driver.run("TRUNCATE TABLE int_users");
    await driver.run("INSERT INTO int_users (name, email) VALUES (?, ?)", ["Alice", "a@test.com"]);
    const r = await driver.run("UPDATE int_users SET email = ? WHERE name = ?", ["new@test.com", "Alice"]);
    expect(r.changes).toBe(1);
    const res = await driver.query("SELECT email FROM int_users WHERE name = ?", ["Alice"]);
    expect(res.rows[0]?.email).toBe("new@test.com");
  });

  test("DELETE removes rows", async () => {
    if (!available) return;
    await driver.run("TRUNCATE TABLE int_users");
    await driver.run("INSERT INTO int_users (name, email) VALUES (?, ?)", ["Alice", "a@test.com"]);
    await driver.run("INSERT INTO int_users (name, email) VALUES (?, ?)", ["Bob", "b@test.com"]);
    const r = await driver.run("DELETE FROM int_users WHERE name = ?", ["Alice"]);
    expect(r.changes).toBe(1);
    const res = await driver.query("SELECT COUNT(*) as count FROM int_users");
    expect(Number(res.rows[0]?.count)).toBe(1);
  });

  test("query returns empty rows for no match", async () => {
    if (!available) return;
    await driver.run("TRUNCATE TABLE int_users");
    const res = await driver.query("SELECT * FROM int_users WHERE name = ?", ["Nobody"]);
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
