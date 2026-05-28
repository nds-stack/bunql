/**
 * Benchmark: @nds-stack/bunql custom PG/MySQL drivers vs Bun.SQL native.
 *
 * Requires running PostgreSQL and MySQL instances.
 * Usage: bun run bench:vs-bun-sql
 *
 * Config via env:
 *   PG_URL="postgres://postgres:postgres@localhost:5432/postgres"
 *   MYSQL_URL="mysql://root:root@localhost:3306/mysql"
 *   ITERATIONS=500
 *   WARMUP=100
 */

import { SQL } from "bun";
import { PGDriver } from "../src/driver/pg.ts";
import { MySQLDriver } from "../src/driver/mysql.ts";

const PG_URL = process.env.PG_URL || "postgres://postgres:postgres@localhost:5432/postgres";
const MYSQL_URL = process.env.MYSQL_URL || "mysql://root:root@localhost:3306/mysql";
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
      await pg.run("INSERT INTO bench_users (id, name, email) VALUES (?, ?, ?)", [i, "warmup", "w@t.com"]);
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
      await pg.run("INSERT INTO bench_users (id, name, email) VALUES (?, ?, ?)", [id2, "test", "t@t.com"]);
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

async function main() {
  console.log(`# vs-bun-sql Benchmark`);
  console.log(`Iterations: ${ITERATIONS}, Warmup: ${WARMUP}`);
  console.log(`PG: ${PG_URL}`);
  console.log(`MySQL: ${MYSQL_URL}`);

  const start = performance.now();

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

  const elapsed = ((performance.now() - start) / 1000).toFixed(1);
  console.log(`\nTotal: ${elapsed}s`);
}

await main();
