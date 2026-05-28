/* eslint-disable no-console */
import { Database } from "bun:sqlite";
import { BunQL } from "../src/bunql.ts";
import initSqlJs from "sql.js";
import { unlinkSync, mkdirSync } from "fs";

const BENCH_DIR = "bench/tmp";
const ITERATIONS = 5000;
const WARMUP = 1000;
const RUNS = 5;
const CONCURRENCY_LEVELS = [10, 50];
const CONC_ITERATIONS = 500;

function setupBenchDir(): void {
  try { mkdirSync(BENCH_DIR, { recursive: true }); } catch { /* exists */ }
}

function setupBenchDB(): string {
  setupBenchDir();
  return `${BENCH_DIR}/bun_bench_${Date.now()}_${Math.random().toString(36).slice(2)}.db`;
}

function cleanupBenchDB(path: string): void {
  try { unlinkSync(path); } catch { /* ignore */ }
}

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function formatOps(ops: number): string {
  if (ops > 1_000_000) return `${(ops / 1_000_000).toFixed(2)}M ops/s`;
  if (ops > 1000) return `${(ops / 1000).toFixed(2)}K ops/s`;
  return `${ops.toFixed(0)} ops/s`;
}

function statsStr(s: { median: number; min: number; max: number }): string {
  return `${formatOps(s.median)} (min ${formatOps(s.min)}, max ${formatOps(s.max)})`;
}

interface Stats { median: number; min: number; max: number; }
interface BenchResult {
  read: Stats;
  write: Stats;
  concurrentWrite: Record<number, Stats>;
}

// --- Bun Benchmarks ---

function runMulti<T>(fn: () => T): { result: T; timings: number[] } {
  const timings: number[] = [];
  let result!: T;
  for (let r = 0; r < RUNS; r++) {
    const start = performance.now();
    result = fn();
    timings.push(performance.now() - start);
  }
  return { result, timings };
}

async function asyncOps(fn: () => Promise<void>): Promise<Stats> {
  const timings: number[] = [];
  for (let r = 0; r < RUNS; r++) {
    const start = performance.now();
    await fn();
    timings.push(performance.now() - start);
  }
  return {
    median: (ITERATIONS / median(timings)) * 1000,
    min: (ITERATIONS / Math.max(...timings)) * 1000,
    max: (ITERATIONS / Math.min(...timings)) * 1000,
  };
}

async function benchRawSQLite(path: string): Promise<BenchResult> {
  const db = new Database(path);
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA synchronous=NORMAL");
  db.run("PRAGMA cache_size=-2000");
  db.run("PRAGMA foreign_keys=ON");
  db.run("CREATE TABLE bench (id INTEGER PRIMARY KEY, val TEXT)");

  const insert = db.prepare("INSERT INTO bench (val) VALUES (?)");
  for (let i = 0; i < WARMUP; i++) insert.run(`seed-${i}`);

  const read = db.prepare("SELECT * FROM bench WHERE id = ?");
  for (let i = 0; i < WARMUP; i++) read.get((i % WARMUP) + 1);

  const { timings: rTimings } = runMulti(() => {
    for (let i = 0; i < ITERATIONS; i++) read.get((i % WARMUP) + 1);
  });
  const readOps: Stats = {
    median: (ITERATIONS / median(rTimings)) * 1000,
    min: (ITERATIONS / Math.max(...rTimings)) * 1000,
    max: (ITERATIONS / Math.min(...rTimings)) * 1000,
  };

  const { timings: wTimings } = runMulti(() => {
    for (let i = 0; i < ITERATIONS; i++) insert.run(`write-${i}`);
  });
  const writeOps: Stats = {
    median: (ITERATIONS / median(wTimings)) * 1000,
    min: (ITERATIONS / Math.max(...wTimings)) * 1000,
    max: (ITERATIONS / Math.min(...wTimings)) * 1000,
  };

  const concurrentWrite: Record<number, Stats> = {};
  for (const level of CONCURRENCY_LEVELS) {
    const cTimings: number[] = [];
    for (let r = 0; r < RUNS; r++) {
      const start = performance.now();
      await Promise.all(Array.from({ length: CONC_ITERATIONS }, (_, i) =>
        (async () => {
          for (let attempt = 0; attempt < 5; attempt++) {
            try { insert.run(`raw-c-${level}-${r}-${i}`); return; } catch {
              await Bun.sleep(10 * Math.pow(2, attempt));
            }
          }
        })(),
      ));
      cTimings.push(performance.now() - start);
    }
    concurrentWrite[level] = {
      median: (CONC_ITERATIONS / median(cTimings)) * 1000,
      min: (CONC_ITERATIONS / Math.max(...cTimings)) * 1000,
      max: (CONC_ITERATIONS / Math.min(...cTimings)) * 1000,
    };
  }

  db.close();
  return { read: readOps, write: writeOps, concurrentWrite };
}

async function benchBunQL(path: string): Promise<BenchResult> {
  const db = new BunQL(path);
  await db.run("CREATE TABLE bench (id INTEGER PRIMARY KEY, val TEXT)");

  for (let i = 0; i < WARMUP; i++) await db.run("INSERT INTO bench (val) VALUES (?)", [`seed-${i}`]);
  for (let i = 0; i < WARMUP; i++) db.query("SELECT * FROM bench WHERE id = ?", [(i % WARMUP) + 1]);

  const read = await asyncOps(async () => {
    for (let i = 0; i < ITERATIONS; i++) db.query("SELECT * FROM bench WHERE id = ?", [(i % WARMUP) + 1]);
  });

  const write = await asyncOps(async () => {
    for (let i = 0; i < ITERATIONS; i++) await db.run("INSERT INTO bench (val) VALUES (?)", [`write-${i}`]);
  });

  const concurrentWrite: Record<number, Stats> = {};
  for (const level of CONCURRENCY_LEVELS) {
    const cTimings: number[] = [];
    for (let r = 0; r < RUNS; r++) {
      const start = performance.now();
      await Promise.all(Array.from({ length: CONC_ITERATIONS }, (_, i) =>
        db.run("INSERT INTO bench (val) VALUES (?)", [`bql-c-${level}-${r}-${i}`]),
      ));
      cTimings.push(performance.now() - start);
    }
    concurrentWrite[level] = {
      median: (CONC_ITERATIONS / median(cTimings)) * 1000,
      min: (CONC_ITERATIONS / Math.max(...cTimings)) * 1000,
      max: (CONC_ITERATIONS / Math.min(...cTimings)) * 1000,
    };
  }

  await db.close();
  return { read, write, concurrentWrite };
}

async function benchManualRetry(path: string): Promise<BenchResult> {
  const db = new Database(path);
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA synchronous=NORMAL");
  db.run("PRAGMA cache_size=-2000");
  db.run("PRAGMA foreign_keys=ON");
  db.run("CREATE TABLE bench (id INTEGER PRIMARY KEY, val TEXT)");

  const insert = db.prepare("INSERT INTO bench (val) VALUES (?)");
  for (let i = 0; i < WARMUP; i++) insert.run(`seed-${i}`);
  const read = db.prepare("SELECT * FROM bench WHERE id = ?");
  for (let i = 0; i < WARMUP; i++) read.get((i % WARMUP) + 1);

  const { timings: rTimings } = runMulti(() => {
    for (let i = 0; i < ITERATIONS; i++) read.get((i % WARMUP) + 1);
  });
  const readOps: Stats = {
    median: (ITERATIONS / median(rTimings)) * 1000,
    min: (ITERATIONS / Math.max(...rTimings)) * 1000,
    max: (ITERATIONS / Math.min(...rTimings)) * 1000,
  };

  const write = await asyncOps(async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      for (let attempt = 0; attempt < 5; attempt++) {
        try { insert.run(`write-${i}`); break; } catch {
          await Bun.sleep(50 * Math.pow(2, attempt));
        }
      }
    }
  });

  const concurrentWrite: Record<number, Stats> = {};
  for (const level of CONCURRENCY_LEVELS) {
    const cTimings: number[] = [];
    for (let r = 0; r < RUNS; r++) {
      const start = performance.now();
      await Promise.all(Array.from({ length: CONC_ITERATIONS }, (_, i) =>
        (async () => {
          for (let attempt = 0; attempt < 5; attempt++) {
            try { insert.run(`man-c-${level}-${r}-${i}`); return; } catch {
              await Bun.sleep(50 * Math.pow(2, attempt));
            }
          }
        })(),
      ));
      cTimings.push(performance.now() - start);
    }
    concurrentWrite[level] = {
      median: (CONC_ITERATIONS / median(cTimings)) * 1000,
      min: (CONC_ITERATIONS / Math.max(...cTimings)) * 1000,
      max: (CONC_ITERATIONS / Math.min(...cTimings)) * 1000,
    };
  }

  db.close();
  return { read: readOps, write, concurrentWrite };
}

async function benchSqlJS(): Promise<BenchResult> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run("CREATE TABLE bench (id INTEGER PRIMARY KEY, val TEXT)");

  const ins = db.prepare("INSERT INTO bench (val) VALUES (?)");
  for (let i = 0; i < WARMUP; i++) ins.run([`seed-${i}`]);
  ins.free();

  const rd = db.prepare("SELECT * FROM bench WHERE id = ?");
  for (let i = 0; i < WARMUP; i++) rd.get([(i % WARMUP) + 1]);

  const { timings: rTimings } = runMulti(() => {
    for (let i = 0; i < ITERATIONS; i++) rd.get([(i % WARMUP) + 1]);
  });
  rd.free();
  const readOps: Stats = {
    median: (ITERATIONS / median(rTimings)) * 1000,
    min: (ITERATIONS / Math.max(...rTimings)) * 1000,
    max: (ITERATIONS / Math.min(...rTimings)) * 1000,
  };

  const { timings: wTimings } = runMulti(() => {
    const ws = db.prepare("INSERT INTO bench (val) VALUES (?)");
    for (let i = 0; i < ITERATIONS; i++) ws.run([`write-${i}`]);
    ws.free();
  });
  const writeOps: Stats = {
    median: (ITERATIONS / median(wTimings)) * 1000,
    min: (ITERATIONS / Math.max(...wTimings)) * 1000,
    max: (ITERATIONS / Math.min(...wTimings)) * 1000,
  };

  const concurrentWrite: Record<number, Stats> = {};

  db.close();
  return { read: readOps, write: writeOps, concurrentWrite };
}

// --- Node.js + Deno subprocess ---

const NODE_GLOBAL = "C:\\laragon\\bin\\nodejs\\node-v22\\node_modules";

function spawnBench(cmd: string, args: string[], envExtra?: Record<string, string>): BenchResult {
  const proc = Bun.spawnSync({
    cmd: [cmd, ...args],
    stdout: "pipe",
    stderr: "inherit",
    env: { ...process.env, ...envExtra },
  });
  const output = new TextDecoder().decode(proc.stdout).trim().split("\n").pop() ?? "{}";
  try {
    return JSON.parse(output) as BenchResult;
  } catch {
    return defaultResult();
  }
}

function defaultResult(): BenchResult {
  const s: Stats = { median: 0, min: 0, max: 0 };
  return { read: s, write: s, concurrentWrite: {} };
}

function spawnNode(script: string, extraArgs: string[] = []): BenchResult {
  return spawnBench("node", [...extraArgs, script], { NODE_PATH: NODE_GLOBAL });
}

function spawnDeno(script: string): BenchResult {
  return spawnBench("C:\\laragon\\bin\\nodejs\\node-v22\\deno.cmd", ["run", "-A", script]);
}

// --- Realistic workloads (BunQL only) ---

async function benchMixedWorkload(path: string) {
  const db = new BunQL(path);
  await db.run("CREATE TABLE bench (id INTEGER PRIMARY KEY, val TEXT)");
  const start = performance.now();
  let reads = 0, writes = 0, txs = 0;
  for (let i = 0; i < 500; i++) {
    if (i % 3 === 0) { await db.run("INSERT INTO bench (val) VALUES (?)", [`write-${i}`]); writes++; }
    else if (i % 3 === 1) { db.query("SELECT COUNT(*) as cnt FROM bench"); reads++; }
    else { await db.transaction(async (tx) => { await tx.run("INSERT INTO bench (val) VALUES (?)", [`tx-${i}`]); }); txs++; }
  }
  const total = performance.now() - start;
  await db.close();
  return { mixed: ((reads + writes + txs) / total) * 1000, reads, writes, txs, totalMs: total.toFixed(1) };
}

async function benchBatchWorkload(path: string) {
  const db = new BunQL(path);
  await db.run("CREATE TABLE bench (id INTEGER PRIMARY KEY, val TEXT)");
  const batchSize = 25;
  const batches = Math.floor(500 / batchSize);
  const start = performance.now();
  for (let b = 0; b < batches; b++) {
    await db.batch(Array.from({ length: batchSize }, (_, i) => ({
      sql: "INSERT INTO bench (val) VALUES (?)", params: [`batch-${b}-${i}`],
    })));
  }
  const duration = performance.now() - start;
  await db.close();
  return { batch: ((batches * batchSize) / duration) * 1000, totalOps: batches * batchSize, durationMs: duration.toFixed(1) };
}

async function benchCachePressure(path: string) {
  const db = new BunQL(path);
  await db.run("CREATE TABLE bench (id INTEGER PRIMARY KEY, val TEXT)");
  for (let i = 0; i < 500; i++) await db.run("INSERT INTO bench (val) VALUES (?)", [`val-${i}`]);
  const start = performance.now();
  for (let i = 0; i < 200; i++) db.query("SELECT * FROM bench WHERE val = ?", [`val-${i % 500}`]);
  const duration = performance.now() - start;
  await db.close();
  return { cachePressure: (200 / duration) * 1000, durationMs: duration.toFixed(1) };
}

// --- Main ---

async function main(): Promise<void> {
  setupBenchDir();

  console.log("\n=== BunQL Benchmarks ===\n");
  console.log(`Iterations: ${ITERATIONS} (warmup: ${WARMUP}), ${RUNS} runs, reporting median (min–max)\n`);

  // --- BUN Runtime ---
  console.log("--- Bun Runtime ---");
  const rawPath = setupBenchDB();
  const raw = await benchRawSQLite(rawPath);
  cleanupBenchDB(rawPath);

  const bqlPath = setupBenchDB();
  const bql = await benchBunQL(bqlPath);
  cleanupBenchDB(bqlPath);

  const manualPath = setupBenchDB();
  const manual = await benchManualRetry(manualPath);
  cleanupBenchDB(manualPath);

  const sqljs = await benchSqlJS();

  console.log(`  bun:sqlite (raw)      | Read:  ${statsStr(raw.read)} | Write: ${statsStr(raw.write)}`);
  console.log(`  BunQL                 | Read:  ${statsStr(bql.read)} | Write: ${statsStr(bql.write)}`);
  console.log(`  Manual retry          | Read:  ${statsStr(manual.read)} | Write: ${statsStr(manual.write)}`);
  console.log(`  sql.js (WASM)         | Read:  ${statsStr(sqljs.read)} | Write: ${statsStr(sqljs.write)}`);

  // --- Node.js Runtime ---
  console.log("\n--- Node.js Runtime ---");
  const bs3 = spawnNode("bench/node-better-sqlite3.cjs");
  console.log(`  better-sqlite3 12.10  | Read:  ${statsStr(bs3.read)} | Write: ${statsStr(bs3.write)}`);

  const sql3 = spawnNode("bench/node-sqlite3.cjs");
  console.log(`  sqlite3 6.0.1          | Read:  ${statsStr(sql3.read)} | Write: ${statsStr(sql3.write)}`);

  const nsql = spawnNode("bench/node-builtin-sqlite.cjs", ["--experimental-sqlite"]);
  console.log(`  node:sqlite (builtin)  | Read:  ${statsStr(nsql.read)} | Write: ${statsStr(nsql.write)}`);

  // --- Deno Runtime ---
  console.log("\n--- Deno Runtime ---");
  const deno = spawnDeno("bench/deno-sqlite.ts");
  console.log(`  Deno SQLite (FFI)     | Read:  ${statsStr(deno.read)} | Write: ${statsStr(deno.write)}`);

  // --- Concurrent Writes ---
  console.log("\n--- Concurrent Writes (500 iter, 5 runs) ---");
  for (const level of CONCURRENCY_LEVELS) {
    const parts: string[] = [
      `bun:sqlite: ${formatOps(raw.concurrentWrite?.[level]?.median ?? 0)}`,
      `Manual: ${formatOps(manual.concurrentWrite?.[level]?.median ?? 0)}`,
      `BunQL: ${formatOps(bql.concurrentWrite?.[level]?.median ?? 0)}`,
    ];
    if (bs3.concurrentWrite?.[level]?.median) parts.push(`better-sql3: ${formatOps(bs3.concurrentWrite[level]!.median)}`);
    if (nsql.concurrentWrite?.[level]?.median) parts.push(`node:sqlite: ${formatOps(nsql.concurrentWrite[level]!.median)}`);
    if (deno.concurrentWrite?.[level]?.median) parts.push(`Deno: ${formatOps(deno.concurrentWrite[level]!.median)}`);
    console.log(`  ${level} concurrent | ${parts.join(" | ")}`);
  }

  // --- Realistic workloads ---
  console.log("\n--- Realistic: Mixed Workload ---");
  const mixedPath = setupBenchDB();
  const mixed = await benchMixedWorkload(mixedPath);
  cleanupBenchDB(mixedPath);
  console.log(`  ${formatOps(mixed.mixed)} (${mixed.reads}r + ${mixed.writes}w + ${mixed.txs}tx in ${mixed.totalMs}ms)`);

  console.log("\n--- Realistic: Batch Operations ---");
  const batchPath = setupBenchDB();
  const batch = await benchBatchWorkload(batchPath);
  cleanupBenchDB(batchPath);
  console.log(`  ${formatOps(batch.batch)} (${batch.totalOps} ops in ${batch.durationMs}ms)`);

  console.log("\n--- Realistic: Cache Pressure ---");
  const cachePath = setupBenchDB();
  const cache = await benchCachePressure(cachePath);
  cleanupBenchDB(cachePath);
  console.log(`  ${formatOps(cache.cachePressure)} (200 queries in ${cache.durationMs}ms)`);

  console.log("\n=== Benchmark Complete ===");
}

await main();
