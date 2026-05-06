/* eslint-disable no-console */
import { Database } from "bun:sqlite";
import { BunQL } from "../src/bunql.ts";
import { unlinkSync, mkdirSync } from "fs";

const BENCH_DIR = "bench/tmp";
const WARMUP_ITERATIONS = 100;
const BENCH_ITERATIONS = 1000;
const CONCURRENCY_LEVELS = [1, 10, 50];

function setupBenchDB(): string {
  try {
    mkdirSync(BENCH_DIR, { recursive: true });
  } catch {
    // dir exists
  }
  const path = `${BENCH_DIR}/bench_${Date.now()}_${Math.random().toString(36).slice(2)}.db`;
  return path;
}

function cleanupBenchDB(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // ignore
  }
}

function formatOps(ops: number): string {
  if (ops > 1000000) return `${(ops / 1000000).toFixed(2)}M ops/s`;
  if (ops > 1000) return `${(ops / 1000).toFixed(2)}K ops/s`;
  return `${ops.toFixed(0)} ops/s`;
}

async function benchRawSQLite(path: string): Promise<{
  read: number;
  write: number;
  concurrentWrite: Record<number, number>;
}> {
  // --- Read benchmark ---
  const rawDb = new Database(path);
  rawDb.run("PRAGMA journal_mode=WAL");
  rawDb.run("CREATE TABLE bench (id INTEGER PRIMARY KEY, val TEXT)");

  // Insert test data
  const insertStmt = rawDb.prepare("INSERT INTO bench (val) VALUES (?)");
  for (let i = 0; i < BENCH_ITERATIONS; i++) {
    insertStmt.run(`value-${i}`);
  }

  // Warmup reads
  const readStmt = rawDb.prepare("SELECT * FROM bench WHERE id = ?");
  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    readStmt.get((i % BENCH_ITERATIONS) + 1);
  }

  // Benchmark reads
  const readStart = performance.now();
  for (let i = 0; i < BENCH_ITERATIONS; i++) {
    readStmt.get((i % BENCH_ITERATIONS) + 1);
  }
  const readDuration = performance.now() - readStart;
  const readOps = (BENCH_ITERATIONS / readDuration) * 1000;

  // --- Write benchmark ---
  const writeStmt = rawDb.prepare("INSERT INTO bench (val) VALUES (?)");
  const writeStart = performance.now();
  for (let i = 0; i < BENCH_ITERATIONS; i++) {
    writeStmt.run(`write-${i}`);
  }
  const writeDuration = performance.now() - writeStart;
  const writeOps = (BENCH_ITERATIONS / writeDuration) * 1000;

  rawDb.close();
  return { read: readOps, write: writeOps, concurrentWrite: {} };
}

async function benchBunQL(
  path: string,
): Promise<{
  read: number;
  write: number;
  concurrentWrite: Record<number, number>;
}> {
  const db = new BunQL(path);
  await db.run("CREATE TABLE bench (id INTEGER PRIMARY KEY, val TEXT)");

  // Insert test data
  for (let i = 0; i < BENCH_ITERATIONS; i++) {
    await db.run("INSERT INTO bench (val) VALUES (?)", [`value-${i}`]);
  }

  // Warmup reads
  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    db.query("SELECT * FROM bench WHERE id = ?", [(i % BENCH_ITERATIONS) + 1]);
  }

  // Benchmark reads
  const readStart = performance.now();
  for (let i = 0; i < BENCH_ITERATIONS; i++) {
    db.query("SELECT * FROM bench WHERE id = ?", [(i % BENCH_ITERATIONS) + 1]);
  }
  const readDuration = performance.now() - readStart;
  const readOps = (BENCH_ITERATIONS / readDuration) * 1000;

  // Benchmark writes
  const writeStart = performance.now();
  for (let i = 0; i < BENCH_ITERATIONS; i++) {
    await db.run("INSERT INTO bench (val) VALUES (?)", [`write-${i}`]);
  }
  const writeDuration = performance.now() - writeStart;
  const writeOps = (BENCH_ITERATIONS / writeDuration) * 1000;

  // Benchmark concurrent writes at different levels
  const concurrentWrite: Record<number, number> = {};
  for (const level of CONCURRENCY_LEVELS) {
    const concurrencyStart = performance.now();
    const batch = Array.from({ length: BENCH_ITERATIONS }, (_, i) =>
      db.run("INSERT INTO bench (val) VALUES (?)", [`concurrent-${level}-${i}`]),
    );
    await Promise.all(batch);
    const concurrencyDuration = performance.now() - concurrencyStart;
    concurrentWrite[level] = (BENCH_ITERATIONS / concurrencyDuration) * 1000;
  }

  await db.close();
  return { read: readOps, write: writeOps, concurrentWrite };
}

async function main(): Promise<void> {
  console.log("\n=== BunQL Benchmarks ===\n");
  console.log(`Warmup: ${WARMUP_ITERATIONS} iterations`);
  console.log(`Benchmark: ${BENCH_ITERATIONS} iterations per test\n`);

  // Benchmark raw bun:sqlite
  console.log("--- Raw bun:sqlite ---");
  const rawPath = setupBenchDB();
  const rawResults = await benchRawSQLite(rawPath);
  cleanupBenchDB(rawPath);

  console.log(`  Read:  ${formatOps(rawResults.read)}`);
  console.log(`  Write: ${formatOps(rawResults.write)}`);

  // Benchmark BunQL
  console.log("\n--- BunQL ---");
  const bunqlPath = setupBenchDB();
  const bunqlResults = await benchBunQL(bunqlPath);
  cleanupBenchDB(bunqlPath);

  console.log(`  Read:  ${formatOps(bunqlResults.read)}`);
  console.log(`  Write: ${formatOps(bunqlResults.write)}`);

  // Concurrent writes
  console.log("\n--- BunQL Concurrent Writes ---");
  for (const level of CONCURRENCY_LEVELS) {
    const ops = bunqlResults.concurrentWrite[level];
    if (ops !== undefined) {
      console.log(`  ${level} concurrent: ${formatOps(ops)}`);
    }
  }

  // Comparison
  console.log("\n--- Overhead vs raw bun:sqlite ---");
  const readOverhead = ((bunqlResults.read - rawResults.read) / rawResults.read) * 100;
  const writeOverhead = ((bunqlResults.write - rawResults.write) / rawResults.write) * 100;
  console.log(`  Read overhead:  ${readOverhead > 0 ? "+" : ""}${readOverhead.toFixed(1)}%`);
  console.log(`  Write overhead: ${writeOverhead > 0 ? "+" : ""}${writeOverhead.toFixed(1)}%`);

  // Summary
  console.log("\n--- Summary ---");
  console.log(`  BunQL reads:  ${formatOps(bunqlResults.read)} (raw: ${formatOps(rawResults.read)})`);
  console.log(`  BunQL writes: ${formatOps(bunqlResults.write)} (raw: ${formatOps(rawResults.write)})`);

  console.log("\n=== Benchmark Complete ===");
}

await main();
