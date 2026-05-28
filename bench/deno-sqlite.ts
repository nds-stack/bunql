// @ts-nocheck — Deno runtime script, not Bun/Node
import { Database } from "jsr:@db/sqlite@0.13";

const ITERATIONS = 5000;
const WARMUP = 1000;
const RUNS = 5;
const CONCURRENCY = [10, 50];
const CONC_ITER = 500;

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const db = new Database("bench/tmp/deno_sqlite_bench.db");
db.exec("PRAGMA journal_mode=WAL");
db.exec("PRAGMA synchronous=NORMAL");
db.exec("PRAGMA cache_size=-2000");
db.exec("PRAGMA foreign_keys=ON");
db.exec("CREATE TABLE bench (id INTEGER PRIMARY KEY, val TEXT)");

const insert = db.prepare("INSERT INTO bench (val) VALUES (?)");
for (let i = 0; i < WARMUP; i++) insert.run(`seed-${i}`);

const read = db.prepare("SELECT * FROM bench WHERE id = ?");
for (let i = 0; i < WARMUP; i++) read.get((i % WARMUP) + 1);

// Read
const rTimings = [];
for (let r = 0; r < RUNS; r++) {
  const start = performance.now();
  for (let i = 0; i < ITERATIONS; i++) read.get((i % WARMUP) + 1);
  rTimings.push(performance.now() - start);
}
const readOps = {
  median: (ITERATIONS / median(rTimings)) * 1000,
  min: (ITERATIONS / Math.max(...rTimings)) * 1000,
  max: (ITERATIONS / Math.min(...rTimings)) * 1000,
};

// Write
const wTimings = [];
for (let r = 0; r < RUNS; r++) {
  const start = performance.now();
  for (let i = 0; i < ITERATIONS; i++) insert.run(`write-${r}-${i}`);
  wTimings.push(performance.now() - start);
}
const writeOps = {
  median: (ITERATIONS / median(wTimings)) * 1000,
  min: (ITERATIONS / Math.max(...wTimings)) * 1000,
  max: (ITERATIONS / Math.min(...wTimings)) * 1000,
};

// Concurrent
const concurrentWrite = {};
for (const level of CONCURRENCY) {
  const cTimings = [];
  for (let r = 0; r < RUNS; r++) {
    const start = performance.now();
    for (let i = 0; i < CONC_ITER; i++) {
      for (let attempt = 0; attempt < 5; attempt++) {
        try { insert.run(`deno-c-${level}-${r}-${i}`); break; } catch {}
      }
    }
    cTimings.push(performance.now() - start);
  }
  concurrentWrite[level] = {
    median: (CONC_ITER / median(cTimings)) * 1000,
    min: (CONC_ITER / Math.max(...cTimings)) * 1000,
    max: (CONC_ITER / Math.min(...cTimings)) * 1000,
  };
}

db.close();

try { Deno.removeSync("bench/tmp/deno_sqlite_bench.db"); } catch {}
try { Deno.removeSync("bench/tmp/deno_sqlite_bench.db-wal"); } catch {}
try { Deno.removeSync("bench/tmp/deno_sqlite_bench.db-shm"); } catch {}

console.log(JSON.stringify({ read: readOps, write: writeOps, concurrentWrite }));
