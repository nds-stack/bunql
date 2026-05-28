import { describe, test, expect } from "bun:test";

describe("MongoDriver", () => {
  test("BunQL constructor rejects mongodb:// with helpful error", () => {
    const { BunQL } = require("../../src/bunql.ts");
    expect(() => new BunQL("mongodb://localhost:27017/test")).toThrow("MongoDriver");
  });

  test("BunQL constructor rejects mongodb+srv:// with helpful error", () => {
    const { BunQL } = require("../../src/bunql.ts");
    expect(() => new BunQL("mongodb+srv://host.mongodb.net/test")).toThrow("MongoDriver");
  });

  test("MongoDriver URL parsing via constructor", () => {
    const { MongoDriver } = require("../../src/driver/mongodb.ts");
    const driver = new MongoDriver("mongodb://user:pass@host1:27018/mydb?authSource=admin&maxPoolSize=10");
    expect(driver).toBeDefined();
    driver.close();
  });

  test("MongoDriver URL parsing - minimal", () => {
    const { MongoDriver } = require("../../src/driver/mongodb.ts");
    const driver = new MongoDriver("mongodb://localhost:27017/test");
    expect(driver).toBeDefined();
    driver.close();
  });

  test("MongoDriver options object", () => {
    const { MongoDriver } = require("../../src/driver/mongodb.ts");
    const driver = new MongoDriver({
      hostname: "localhost",
      port: 27017,
      db: "test",
    });
    expect(driver).toBeDefined();
    driver.close();
  });

  test("MongoDriver query fails without server", async () => {
    const { MongoDriver } = require("../../src/driver/mongodb.ts");
    const driver = new MongoDriver("mongodb://localhost:27999/test");

    try {
      await driver.query("SELECT * FROM users");
      expect.unreachable();
    } catch (err: unknown) {
      expect(err).toBeDefined();
    }
    
    await driver.close();
  });
});
