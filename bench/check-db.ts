/**
 * Connection test for MySQL, PostgreSQL, MongoDB via Bun.SQL + our custom drivers.
 * Run: bun run bench/check-db.ts
 */

import { SQL } from "bun";
import { PGDriver } from "../src/driver/pg.ts";
import { MySQLDriver } from "../src/driver/mysql.ts";
import { MongoDriver } from "../src/driver/mongodb.ts";

async function testPG(): Promise<void> {
  console.log("\n── PostgreSQL ──");
  try {
    const bunSql = new SQL("postgres://postgres@localhost:5432/postgres");
    const result = await bunSql`SELECT 1 as ok`;
    console.log(`  ✅ Bun.SQL:   connected — ${JSON.stringify(result[0])}`);
    await bunSql.close();

    const pg = new PGDriver("postgres://postgres@localhost:5432/postgres");
    const r2 = await pg.query("SELECT 1 as ok");
    console.log(`  ✅ PGDriver:  connected — ${JSON.stringify(r2.rows[0])}`);
    await pg.close();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  ❌ Error: ${msg.split("\n")[0]}`);
  }
}

async function testMySQL(): Promise<void> {
  console.log("\n── MySQL ──");
  try {
    const bunSql = new SQL("mysql://root@localhost:3306/mysql");
    const result = await bunSql`SELECT 1 as ok`;
    console.log(`  ✅ Bun.SQL:   connected — ${JSON.stringify(result[0])}`);
    await bunSql.close();

    const mysql = new MySQLDriver("mysql://root@localhost:3306/mysql");
    const r2 = await mysql.query("SELECT 1 as ok");
    console.log(`  ✅ MySQLDriver: connected — ${JSON.stringify(r2.rows[0])}`);
    await mysql.close();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  ❌ Error: ${msg.split("\n")[0]}`);
  }
}

async function testMongoDB(): Promise<void> {
  console.log("\n── MongoDB ──");
  try {
    const mongo = new MongoDriver("mongodb://localhost:27017/test");
    const result = await mongo.query("SELECT * FROM system.version");
    console.log(`  ✅ MongoDriver: connected — ${JSON.stringify(result.rows[0])}`);
    await mongo.close();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  ❌ MongoDriver: ${msg}`);
  }
}

console.log("=== Database Connection Test ===");
console.log(`Time: ${new Date().toISOString()}\n`);

await testPG();
await testMySQL();
await testMongoDB();

console.log("\n=== Done ===");
