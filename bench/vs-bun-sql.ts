/**
 * Benchmark: @nds-stack/bunql drivers vs native Bun backends.
 *
 * Backends tested:
 *   - SQLite: bun:sqlite (Database) vs BunQL facade
 *   - PG:     Bun.SQL vs PGDriver (custom TCP)
 *   - MySQL:  Bun.SQL vs MySQLDriver (custom TCP)
 *   - MongoDB: MongoDriver only (Bun has no built-in MongoDB driver)
 *
 * Usage: bun run bench/vs-bun-sql.ts
 *
 * Config via env:
 *   PG_URL="postgres://postgres@localhost:5432/postgres"
 *   MYSQL_URL="mysql://root@localhost:3306/mysql"
 *   MONGO_URL="mongodb://localhost:27017/test_bench"
 *   ITERATIONS=500
 *   WARMUP=100
 */

import { SQL } from "bun";
import { Database as BunSQLiteDatabase } from "bun:sqlite";
import { PGDriver } from "../src/driver/pg.ts";
import { MySQLDriver } from "../src/driver/mysql.ts";
import { MongoDriver } from "../src/driver/mongodb.ts";
import { RedisDriver } from "../src/driver/redis.ts";
import { BunQL } from "../src/bunql.ts";
import { unlinkSync } from "fs";

const PG_URL = process.env.PG_URL || "postgres://postgres@localhost:5432/postgres";
const MYSQL_URL = process.env.MYSQL_URL || "mysql://root@localhost:3306/mysql";
const MONGO_URL = process.env.MONGO_URL || "mongodb://localhost:27017/test_bench";
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/0";
const ITERATIONS = parseInt(process.env.ITERATIONS || "500", 10);
const WARMUP = parseInt(process.env.WARMUP || "100", 10);

interface BenchResult {
  median: number;
  min: number;
  max: number;
  ops: number;
}

function stats(nums: number[]): BenchResult {
  const sorted = [...nums].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const min = sorted[0]!;
  const max = sorted[sorted.length - 1]!;
  const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return { median, min, max, ops: avg > 0 ? Math.round(1000 / (avg / ITERATIONS)) : 0 };
}

function printRow(label: string, bunSql: BenchResult, custom: BenchResult): void {
  const overhead = bunSql.median > 0 ? ((custom.median - bunSql.median) / bunSql.median * 100).toFixed(1) : "-";
  const bunOps = bunSql.ops.toLocaleString();
  const customOps = custom.ops.toLocaleString();
  console.log(
    `| ${label.padEnd(36)} | ${bunOps.padStart(10)} ops/s | ${customOps.padStart(10)} ops/s | ${overhead.padStart(5)}% |`,
  );
}

function printBareRow(label: string, result: BenchResult): void {
  const ops = result.ops.toLocaleString();
  console.log(`| ${label.padEnd(36)} | ${ops.padStart(10)} ops/s |`);
}

async function benchSQLite(iter: number, warmup: number): Promise<void> {
  console.log("\n## SQLite: bun:sqlite (Database) vs BunQL\n");
  console.log("| Operation | bun:sqlite | BunQL | Overhead |");
  console.log("|-----------|------------|-------|----------|");

  function freshRaw(sql: string): { db: BunSQLiteDatabase; stmt: ReturnType<BunSQLiteDatabase["prepare"]> } {
    const db = new BunSQLiteDatabase(":memory:");
    db.run("CREATE TABLE bench_users (id INTEGER, name TEXT, email TEXT)");
    return { db, stmt: db.prepare(sql) };
  }

  function freshBQ(): BunQL {
    const db = new BunQL(":memory:");
    db.run("CREATE TABLE bench_users (id INTEGER, name TEXT, email TEXT)");
    return db;
  }

  // ─── SELECT ─────────────────────────────────────────
  {
    const { db: raw, stmt: rawStmt } = freshRaw("SELECT * FROM bench_users WHERE id = ?");
    raw.run("INSERT INTO bench_users (id, name, email) VALUES (1, 'Alice', 'a@t.com')");
    const rawDurations: number[] = [];
    for (let i = 0; i < warmup; i++) rawStmt.get(1);
    for (let i = 0; i < iter; i++) {
      const t0 = performance.now();
      rawStmt.get(1);
      rawDurations.push(performance.now() - t0);
    }
    raw.close();

    const bunql = freshBQ();
    bunql.run("INSERT INTO bench_users (id, name, email) VALUES (1, 'Alice', 'a@t.com')");
    const bqDurations: number[] = [];
    for (let i = 0; i < warmup; i++) bunql.query("SELECT * FROM bench_users WHERE id = 1");
    for (let i = 0; i < iter; i++) {
      const t0 = performance.now();
      bunql.query("SELECT * FROM bench_users WHERE id = 1");
      bqDurations.push(performance.now() - t0);
    }
    bunql.close();

    printRow("SELECT one row (by id, cached stmt)", stats(rawDurations), stats(bqDurations));
  }

  // ─── INSERT ─────────────────────────────────────────
  {
    const { db: raw, stmt: rawStmt } = freshRaw("INSERT INTO bench_users (id, name, email) VALUES (?, ?, ?)");
    const rawDurations: number[] = [];
    for (let i = -warmup; i < iter; i++) {
      const id = i < 0 ? i + warmup : i;
      const t0 = performance.now();
      rawStmt.run(id, "test", "t@t.com");
      if (i >= 0) rawDurations.push(performance.now() - t0);
    }
    raw.close();

    const bunql = freshBQ();
    const bqDurations: number[] = [];
    for (let i = -warmup; i < iter; i++) {
      const id = i < 0 ? i + warmup : i;
      const t0 = performance.now();
      bunql.run("INSERT INTO bench_users (id, name, email) VALUES (?, ?, ?)", [id, "test", "t@t.com"]);
      if (i >= 0) bqDurations.push(performance.now() - t0);
    }
    bunql.close();

    printRow("INSERT one row (parameterized)", stats(rawDurations), stats(bqDurations));
  }
}

async function benchMongoDB(iter: number, warmup: number): Promise<void> {
  console.log("\n## MongoDB: MongoDriver (Bun has no built-in MongoDB driver)\n");
  console.log("| Operation | MongoDriver |");
  console.log("|-----------|-------------|");

  const mongo = new MongoDriver(MONGO_URL);

  // Setup
  await mongo.run("DELETE FROM bench_users");

  // ─── Simple SELECT ──────────────────────────────────
  {
    await mongo.run("INSERT INTO bench_users (_id, name, email) VALUES (1, 'Alice', 'a@t.com')");

    const durations: number[] = [];

    for (let i = 0; i < warmup; i++) {
      await mongo.query("SELECT * FROM bench_users WHERE _id = 1");
    }

    for (let i = 0; i < iter; i++) {
      const t0 = performance.now();
      await mongo.query("SELECT * FROM bench_users WHERE _id = 1");
      durations.push(performance.now() - t0);
    }

    printBareRow("SELECT one row (by _id, SQL)", stats(durations));
  }

  // ─── Single INSERT ──────────────────────────────────
  {
    await mongo.run("DELETE FROM bench_users");
    const durations: number[] = [];

    for (let i = 0; i < warmup; i++) {
      await mongo.run(`INSERT INTO bench_users (_id, name, email) VALUES (${i}, 'warmup', 'w@t.com')`);
    }
    await mongo.run("DELETE FROM bench_users");

    let counter = 0;
    for (let i = 0; i < iter; i++) {
      const id = counter++;
      const t0 = performance.now();
      await mongo.run(`INSERT INTO bench_users (_id, name, email) VALUES (${id}, 'test', 't@t.com')`);
      durations.push(performance.now() - t0);
    }

    printBareRow("INSERT one row (SQL with literals)", stats(durations));
  }

  await mongo.run("DELETE FROM bench_users");
  await mongo.close();
}

async function benchPG(iter: number, warmup: number): Promise<void> {
  console.log("\n## PostgreSQL: Bun.SQL vs PGDriver\n");
  console.log("| Operation | Bun.SQL | PGDriver | Overhead |");
  console.log("|-----------|---------|----------|----------|");

  // Setup
  const bunSql = new SQL(PG_URL);
  const pg = new PGDriver(PG_URL);

  await bunSql`CREATE TABLE IF NOT EXISTS bench_users (id INTEGER, name TEXT, email TEXT)`;
  await pg.run("CREATE TABLE IF NOT EXISTS bench_users (id INTEGER, name TEXT, email TEXT)");

  // Clean
  await bunSql`DELETE FROM bench_users`;
  await pg.run("DELETE FROM bench_users");

  // ─── Simple SELECT ──────────────────────────────────
  {
    // Insert one row for read test
    await bunSql`INSERT INTO bench_users (id, name, email) VALUES (1, 'Alice', 'a@t.com')`;
    await pg.run("INSERT INTO bench_users (id, name, email) VALUES (1, 'Alice', 'a@t.com')");

    const bunDurations: number[] = [];
    const customDurations: number[] = [];

    for (let i = 0; i < warmup; i++) {
      await bunSql`SELECT * FROM bench_users WHERE id = 1`;
      await pg.query("SELECT * FROM bench_users WHERE id = 1");
    }

    for (let i = 0; i < iter; i++) {
      const t0 = performance.now();
      await bunSql`SELECT * FROM bench_users WHERE id = 1`;
      bunDurations.push(performance.now() - t0);

      const t1 = performance.now();
      await pg.query("SELECT * FROM bench_users WHERE id = 1");
      customDurations.push(performance.now() - t1);
    }

    printRow("SELECT one row (parameterized)", stats(bunDurations), stats(customDurations));
  }

  // ─── Single INSERT ──────────────────────────────────
  {
    const bunDurations: number[] = [];
    const customDurations: number[] = [];

    for (let i = 0; i < warmup; i++) {
      await bunSql`INSERT INTO bench_users (id, name, email) VALUES (${i}, 'warmup', 'w@t.com')`;
      await pg.run("INSERT INTO bench_users (id, name, email) VALUES ($1, $2, $3)", [i, "warmup", "w@t.com"]);
    }
    await bunSql`DELETE FROM bench_users`;
    await pg.run("DELETE FROM bench_users");

    let counter = 0;
    for (let i = 0; i < iter; i++) {
      const id = counter++;
      const t0 = performance.now();
      await bunSql`INSERT INTO bench_users (id, name, email) VALUES (${id}, 'test', 't@t.com')`;
      bunDurations.push(performance.now() - t0);

      const id2 = counter++;
      const t1 = performance.now();
      await pg.run("INSERT INTO bench_users (id, name, email) VALUES ($1, $2, $3)", [id2, "test", "t@t.com"]);
      customDurations.push(performance.now() - t1);
    }

    printRow("INSERT one row (parameterized)", stats(bunDurations), stats(customDurations));
  }

  await bunSql`DROP TABLE IF EXISTS bench_users`;
  await pg.run("DROP TABLE IF EXISTS bench_users");
  await bunSql.close();
  await pg.close();
}

async function benchMySQL(iter: number, warmup: number): Promise<void> {
  console.log("\n## MySQL: Bun.SQL vs MySQLDriver\n");
  console.log("| Operation | Bun.SQL | MySQLDriver | Overhead |");
  console.log("|-----------|---------|-------------|----------|");

  const bunSql = new SQL(MYSQL_URL);
  const mysql = new MySQLDriver(MYSQL_URL);

  await bunSql`CREATE TABLE IF NOT EXISTS bench_users (id INTEGER, name TEXT, email TEXT)`;
  await mysql.run("CREATE TABLE IF NOT EXISTS bench_users (id INTEGER, name TEXT, email TEXT)");
  await bunSql`DELETE FROM bench_users`;
  await mysql.run("DELETE FROM bench_users");

  // ─── Simple SELECT ──────────────────────────────────
  {
    await bunSql`INSERT INTO bench_users (id, name, email) VALUES (1, 'Alice', 'a@t.com')`;
    await mysql.run("INSERT INTO bench_users (id, name, email) VALUES (1, 'Alice', 'a@t.com')");

    const bunDurations: number[] = [];
    const customDurations: number[] = [];

    for (let i = 0; i < warmup; i++) {
      await bunSql`SELECT * FROM bench_users WHERE id = 1`;
      await mysql.query("SELECT * FROM bench_users WHERE id = 1");
    }

    for (let i = 0; i < iter; i++) {
      const t0 = performance.now();
      await bunSql`SELECT * FROM bench_users WHERE id = 1`;
      bunDurations.push(performance.now() - t0);

      const t1 = performance.now();
      await mysql.query("SELECT * FROM bench_users WHERE id = 1");
      customDurations.push(performance.now() - t1);
    }

    printRow("SELECT one row (parameterized)", stats(bunDurations), stats(customDurations));
  }

  // ─── Single INSERT ──────────────────────────────────
  {
    const bunDurations: number[] = [];
    const customDurations: number[] = [];

    for (let i = 0; i < warmup; i++) {
      await bunSql`INSERT INTO bench_users (id, name, email) VALUES (${i}, 'warmup', 'w@t.com')`;
      await mysql.run("INSERT INTO bench_users (id, name, email) VALUES (?, ?, ?)", [i, "warmup", "w@t.com"]);
    }
    await bunSql`DELETE FROM bench_users`;
    await mysql.run("DELETE FROM bench_users");

    let counter = 0;
    for (let i = 0; i < iter; i++) {
      const id = counter++;
      const t0 = performance.now();
      await bunSql`INSERT INTO bench_users (id, name, email) VALUES (${id}, 'test', 't@t.com')`;
      bunDurations.push(performance.now() - t0);

      const id2 = counter++;
      const t1 = performance.now();
      await mysql.run("INSERT INTO bench_users (id, name, email) VALUES (?, ?, ?)", [id2, "test", "t@t.com"]);
      customDurations.push(performance.now() - t1);
    }

    printRow("INSERT one row (parameterized)", stats(bunDurations), stats(customDurations));
  }

  await bunSql`DROP TABLE IF EXISTS bench_users`;
  await mysql.run("DROP TABLE IF EXISTS bench_users");
  await bunSql.close();
  await mysql.close();
}

async function benchRedis(iter: number, warmup: number): Promise<void> {
  console.log("\n## Redis: RedisDriver (Bun has no built-in Redis driver)\n");
  console.log("| Operation | RedisDriver |");
  console.log("|-----------|-------------|");

  const redis = new RedisDriver(REDIS_URL);

  // Setup
  await redis.run("DELETE FROM bench_users");

  // ─── Simple SELECT ──────────────────────────────────
  {
    await redis.run("INSERT INTO bench_users (_id, name, email) VALUES (1, 'Alice', 'a@t.com')");

    const durations: number[] = [];

    for (let i = 0; i < warmup; i++) {
      await redis.query("SELECT * FROM bench_users WHERE _id = 1");
    }

    for (let i = 0; i < iter; i++) {
      const t0 = performance.now();
      await redis.query("SELECT * FROM bench_users WHERE _id = 1");
      durations.push(performance.now() - t0);
    }

    printBareRow("SELECT one row (by _id, SQL)", stats(durations));
  }

  // ─── Single INSERT ──────────────────────────────────
  {
    await redis.run("DELETE FROM bench_users");
    const durations: number[] = [];

    let counter = 0;
    for (let i = -warmup; i < iter; i++) {
      const id = i < 0 ? i + warmup : i;
      const t0 = performance.now();
      await redis.run(`INSERT INTO bench_users (_id, name, email) VALUES (${id}, 'test', 't@t.com')`);
      if (i >= 0) durations.push(performance.now() - t0);
    }

    printBareRow("INSERT one row (SQL with literals)", stats(durations));
  }

  await redis.run("DELETE FROM bench_users");
  await redis.close();
}

async function main() {
  console.log(`# vs-bun-sql Benchmark`);
  console.log(`Iterations: ${ITERATIONS}, Warmup: ${WARMUP}`);
  console.log(`PG: ${PG_URL}`);
  console.log(`MySQL: ${MYSQL_URL}`);
  console.log(`MongoDB: ${MONGO_URL}`);
  console.log(`Redis: ${REDIS_URL}`);

  const start = performance.now();

  try {
    await benchSQLite(ITERATIONS, WARMUP);
  } catch (e) {
    console.log(`\nSQLite benchmark skipped: ${e}`);
  }

  try {
    await benchPG(ITERATIONS, WARMUP);
  } catch (e) {
    console.log(`\nPG benchmark skipped: ${e}`);
  }

  try {
    await benchMySQL(ITERATIONS, WARMUP);
  } catch (e) {
    console.log(`\nMySQL benchmark skipped: ${e}`);
  }

  try {
    await benchMongoDB(ITERATIONS, WARMUP);
  } catch (e) {
    console.log(`\nMongoDB benchmark skipped: ${e}`);
  }

  try {
    await benchRedis(ITERATIONS, WARMUP);
  } catch (e) {
    console.log(`\nRedis benchmark skipped: ${e}`);
  }

  const elapsed = ((performance.now() - start) / 1000).toFixed(1);
  console.log(`\nTotal: ${elapsed}s`);
}

await main();
