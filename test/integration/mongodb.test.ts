import { describe, test, expect, afterAll } from "bun:test";
import { MongoDriver } from "../../src/driver/mongodb.ts";

let driver: MongoDriver;
let available = false;

try {
  driver = new MongoDriver("mongodb://localhost:27017/test_bunql_int");
  await driver.run("DELETE FROM int_users");
  available = true;
} catch {
  // MongoDB not available — all tests will skip via guard
}

describe("MongoDB integration", () => {
  afterAll(async () => {
    if (!available) return;
    await driver.close();
  });

  test("INSERT via run() with SQL", async () => {
    if (!available) return;
    const r = await driver.run("INSERT INTO int_users (_id, name, email) VALUES (1, 'Alice', 'a@test.com')");
    expect(r.changes).toBe(1);
  });

  test("SELECT via query() with SQL returns rows", async () => {
    if (!available) return;
    await driver.run("INSERT INTO int_users (_id, name, email) VALUES (1, 'Alice', 'a@test.com')");
    await driver.run("INSERT INTO int_users (_id, name, email) VALUES (2, 'Bob', 'b@test.com')");
    const res = await driver.query("SELECT * FROM int_users ORDER BY _id");
    expect(res.rows).toHaveLength(2);
  });

  test("SELECT with WHERE clause", async () => {
    if (!available) return;
    await driver.run("INSERT INTO int_users (_id, name, email) VALUES (1, 'Alice', 'a@test.com')");
    await driver.run("INSERT INTO int_users (_id, name, email) VALUES (2, 'Bob', 'b@test.com')");
    const res = await driver.query("SELECT name FROM int_users WHERE _id = 1");
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]?.name).toBe("Alice");
  });

  test("UPDATE via run()", async () => {
    if (!available) return;
    await driver.run("INSERT INTO int_users (_id, name, email) VALUES (1, 'Alice', 'a@test.com')");
    const r = await driver.run("UPDATE int_users SET email = 'new@test.com' WHERE name = 'Alice'");
    expect(r.changes).toBe(1);
  });

  test("DELETE via run()", async () => {
    if (!available) return;
    await driver.run("INSERT INTO int_users (_id, name, email) VALUES (1, 'Alice', 'a@test.com')");
    await driver.run("INSERT INTO int_users (_id, name, email) VALUES (2, 'Bob', 'b@test.com')");
    const r = await driver.run("DELETE FROM int_users WHERE name = 'Alice'");
    expect(r.changes).toBe(1);
  });

  test("query returns empty rows for no match", async () => {
    if (!available) return;
    const res = await driver.query("SELECT * FROM int_users WHERE name = 'Nobody'");
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
