/* eslint-disable no-console */
import { Database } from "bun:sqlite";
import { BunQL } from "../src/bunql.ts";
import { unlinkSync, mkdirSync } from "fs";

const BENCH_DIR = "bench/tmp";
const BENCH_ITERATIONS = 500;
const CONCURRENCY_LEVELS = [10, 50];

function setupBenchDB(): string {
  try {
    mkdirSync(BENCH_DIR, { recursive: true });
  } catch {
    // dir exists
  }
  return `${BENCH_DIR}/bench_${Date.now()}_${Math.random().toString(36).slice(2)}.db`;
}

function cleanupBenchDB(path: string): void {
  try { unlinkSync(path); } catch { /* ignore */ }
}

function formatOps(ops: number): string {
  if (ops > 1000000) return `${(ops / 1000000).toFixed(2)}M ops/s`;
  if (ops > 1000) return `${(ops / 1000).toFixed(2)}K ops/s`;
  return `${ops.toFixed(0)} ops/s`;
}

async function benchRawSQLite(path: string) {
  const db = new Database(path);
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA synchronous=NORMAL");
  db.run("PRAGMA cache_size=-2000");
  db.run("PRAGMA foreign_keys=ON");
  db.run("CREATE TABLE bench (id INTEGER PRIMARY KEY, val TEXT)");

  const insert = db.prepare("INSERT INTO bench (val) VALUES (?)");
  for (let i = 0; i < BENCH_ITERATIONS; i++) insert.run(`value-${i}`);

  const read = db.prepare("SELECT * FROM bench WHERE id = ?");
  read.get(1); // warmup

  const readStart = performance.now();
  for (let i = 0; i < BENCH_ITERATIONS; i++) read.get((i % BENCH_ITERATIONS) + 1);
  const readOps = (BENCH_ITERATIONS / (performance.now() - readStart)) * 1000;

  const writeStart = performance.now();
  for (let i = 0; i < BENCH_ITERATIONS; i++) insert.run(`write-${i}`);
  const writeOps = (BENCH_ITERATIONS / (performance.now() - writeStart)) * 1000;

  const concurrentWrite: Record<number, number> = {};
  for (const level of CONCURRENCY_LEVELS) {
    const start = performance.now();
    await Promise.all(Array.from({ length: BENCH_ITERATIONS }, (_, i) =>
      (async () => {
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            insert.run(`raw-concurrent-${level}-${i}`);
            return;
          } catch {
            await Bun.sleep(10 * Math.pow(2, attempt));
          }
        }
      })(),
    ));
    concurrentWrite[level] = (BENCH_ITERATIONS / (performance.now() - start)) * 1000;
  }

  db.close();
  return { read: readOps, write: writeOps, concurrentWrite };
}

async function benchBunQL(path: string) {
  const db = new BunQL(path);
  await db.run("CREATE TABLE bench (id INTEGER PRIMARY KEY, val TEXT)");

  for (let i = 0; i < BENCH_ITERATIONS; i++)
    await db.run("INSERT INTO bench (val) VALUES (?)", [`value-${i}`]);

  db.query("SELECT * FROM bench WHERE id = ?", [1]); // warmup

  const readStart = performance.now();
  for (let i = 0; i < BENCH_ITERATIONS; i++)
    db.query("SELECT * FROM bench WHERE id = ?", [(i % BENCH_ITERATIONS) + 1]);
  const readOps = (BENCH_ITERATIONS / (performance.now() - readStart)) * 1000;

  const writeStart = performance.now();
  for (let i = 0; i < BENCH_ITERATIONS; i++)
    await db.run("INSERT INTO bench (val) VALUES (?)", [`write-${i}`]);
  const writeOps = (BENCH_ITERATIONS / (performance.now() - writeStart)) * 1000;

  const concurrentWrite: Record<number, number> = {};
  for (const level of CONCURRENCY_LEVELS) {
    const start = performance.now();
    await Promise.all(Array.from({ length: BENCH_ITERATIONS }, (_, i) =>
      db.run("INSERT INTO bench (val) VALUES (?)", [`concurrent-${level}-${i}`]),
    ));
    concurrentWrite[level] = (BENCH_ITERATIONS / (performance.now() - start)) * 1000;
  }

  await db.close();
  return { read: readOps, write: writeOps, concurrentWrite };
}

// --- Realistic workload benchmarks ---

async function benchMixedWorkload(path: string) {
  const db = new BunQL(path);
  await db.run("CREATE TABLE bench (id INTEGER PRIMARY KEY, val TEXT)");

  const start = performance.now();
  let reads = 0, writes = 0, txs = 0;

  for (let i = 0; i < BENCH_ITERATIONS; i++) {
    if (i % 3 === 0) {
      await db.run("INSERT INTO bench (val) VALUES (?)", [`write-${i}`]);
      writes++;
    } else if (i % 3 === 1) {
      db.query("SELECT COUNT(*) as cnt FROM bench");
      reads++;
    } else {
      await db.transaction(async (tx) => {
        await tx.run("INSERT INTO bench (val) VALUES (?)", [`tx-${i}`]);
      });
      txs++;
    }
  }

  const total = performance.now() - start;
  const totalOps = reads + writes + txs;
  await db.close();
  return { mixed: (totalOps / total) * 1000, reads, writes, txs, totalMs: total.toFixed(1) };
}

async function benchBatchWorkload(path: string) {
  const db = new BunQL(path);
  await db.run("CREATE TABLE bench (id INTEGER PRIMARY KEY, val TEXT)");

  const start = performance.now();
  const batchSize = 25;
  const batches = Math.floor(BENCH_ITERATIONS / batchSize);

  for (let b = 0; b < batches; b++) {
    await db.batch(Array.from({ length: batchSize }, (_, i) => ({
      sql: "INSERT INTO bench (val) VALUES (?)",
      params: [`batch-${b}-${i}`],
    })));
  }

  const duration = performance.now() - start;
  const totalOps = batches * batchSize;
  await db.close();
  return { batch: (totalOps / duration) * 1000, totalOps, durationMs: duration.toFixed(1) };
}

async function benchCachePressure(path: string) {
  const db = new BunQL(path);
  await db.run("CREATE TABLE bench (id INTEGER PRIMARY KEY, val TEXT)");

  for (let i = 0; i < BENCH_ITERATIONS; i++)
    await db.run("INSERT INTO bench (val) VALUES (?)", [`val-${i}`]);

  // 200 unique SQL patterns to stress cache (maxSize=100, triggers evictions)
  const start = performance.now();
  for (let i = 0; i < 200; i++) {
    db.query("SELECT * FROM bench WHERE val = ?", [`val-${i % BENCH_ITERATIONS}`]);
  }
  const duration = performance.now() - start;
  await db.close();
  return { cachePressure: (200 / duration) * 1000, durationMs: duration.toFixed(1) };
}

async function main(): Promise<void> {
  console.log("\n=== BunQL Benchmarks ===\n");
  console.log(`Iterations per test: ${BENCH_ITERATIONS}\n`);

  // --- Synthetic benchmarks ---
  console.log("--- Synthetic: Read/Write ---");
  const rawPath = setupBenchDB();
  const raw = await benchRawSQLite(rawPath);
  cleanupBenchDB(rawPath);

  const bqlPath = setupBenchDB();
  const bql = await benchBunQL(bqlPath);
  cleanupBenchDB(bqlPath);

  console.log(`  Raw bun:sqlite  | Read: ${formatOps(raw.read)} | Write: ${formatOps(raw.write)}`);
  console.log(`  BunQL           | Read: ${formatOps(bql.read)} | Write: ${formatOps(bql.write)}`);

  console.log("\n  Overhead vs raw bun:sqlite:");
  console.log(`  Read overhead:  ${(((bql.read - raw.read) / raw.read) * 100).toFixed(1)}%`);
  console.log(`  Write overhead: ${(((bql.write - raw.write) / raw.write) * 100).toFixed(1)}%`);

  console.log("\n--- Synthetic: Concurrent Writes ---");
  for (const level of CONCURRENCY_LEVELS) {
    const rawOps = raw.concurrentWrite?.[level] ?? 0;
    const bqlOps = bql.concurrentWrite?.[level] ?? 0;
    console.log(`  ${level} concurrent | Raw: ${formatOps(rawOps)} | BunQL: ${formatOps(bqlOps)}`);
  }

  // --- Realistic workloads ---
  console.log("\n--- Realistic: Mixed Workload (read/write/tx) ---");
  const mixedPath = setupBenchDB();
  const mixed = await benchMixedWorkload(mixedPath);
  cleanupBenchDB(mixedPath);
  console.log(`  ${formatOps(mixed.mixed)} (${mixed.reads}r + ${mixed.writes}w + ${mixed.txs}tx in ${mixed.totalMs}ms)`);

  console.log("\n--- Realistic: Batch Operations ---");
  const batchPath = setupBenchDB();
  const batch = await benchBatchWorkload(batchPath);
  cleanupBenchDB(batchPath);
  console.log(`  ${formatOps(batch.batch)} (${batch.totalOps} ops in ${batch.durationMs}ms)`);

  console.log("\n--- Realistic: Cache Pressure (200 unique queries) ---");
  const cachePath = setupBenchDB();
  const cache = await benchCachePressure(cachePath);
  cleanupBenchDB(cachePath);
  console.log(`  ${formatOps(cache.cachePressure)} (200 queries in ${cache.durationMs}ms)`);

  console.log("\n=== Benchmark Complete ===");
}

await main();
