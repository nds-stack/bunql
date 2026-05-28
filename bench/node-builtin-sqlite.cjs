const { DatabaseSync } = require("node:sqlite");
const { mkdirSync, unlinkSync } = require("fs");

const ITERATIONS = 5000;
const WARMUP = 1000;
const RUNS = 5;
const CONCURRENCY = [10, 50];
const CONC_ITER = 500;
const BENCH_DIR = "bench/tmp";

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function makeStats(timings) {
  return {
    median: (ITERATIONS / median(timings)) * 1000,
    min: (ITERATIONS / Math.max(...timings)) * 1000,
    max: (ITERATIONS / Math.min(...timings)) * 1000,
  };
}

(async () => {
try { mkdirSync(BENCH_DIR, { recursive: true }); } catch {}

const dbPath = `${BENCH_DIR}/node_native_${Date.now()}.db`;
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode=WAL");
db.exec("PRAGMA synchronous=NORMAL");
db.exec("PRAGMA cache_size=-2000");
db.exec("PRAGMA foreign_keys=ON");
db.exec("CREATE TABLE bench (id INTEGER PRIMARY KEY, val TEXT)");

const insert = db.prepare("INSERT INTO bench (val) VALUES (?)");
for (let i = 0; i < WARMUP; i++) insert.run(`seed-${i}`);

const read = db.prepare("SELECT * FROM bench WHERE id = ?");
for (let i = 0; i < WARMUP; i++) read.get((i % WARMUP) + 1);

const rTimings = [];
for (let r = 0; r < RUNS; r++) {
  const start = performance.now();
  for (let i = 0; i < ITERATIONS; i++) read.get((i % WARMUP) + 1);
  rTimings.push(performance.now() - start);
}
const readOps = makeStats(rTimings);

const wTimings = [];
for (let r = 0; r < RUNS; r++) {
  const start = performance.now();
  for (let i = 0; i < ITERATIONS; i++) insert.run(`write-${r}-${i}`);
  wTimings.push(performance.now() - start);
}
const writeOps = makeStats(wTimings);

const concurrentWrite = {};
for (const level of CONCURRENCY) {
  const cTimings = [];
  for (let r = 0; r < RUNS; r++) {
    const start = performance.now();
    const tasks = [];
    for (let i = 0; i < CONC_ITER; i++) {
      tasks.push(new Promise((resolve) => {
        setImmediate(() => {
          for (let attempt = 0; attempt < 5; attempt++) {
            try { insert.run(`nsc-c-${level}-${r}-${i}`); resolve(); return; } catch {}
          }
          resolve();
        });
      }));
    }
    await Promise.all(tasks);
    cTimings.push(performance.now() - start);
  }
  concurrentWrite[level] = {
    median: (CONC_ITER / median(cTimings)) * 1000,
    min: (CONC_ITER / Math.max(...cTimings)) * 1000,
    max: (CONC_ITER / Math.min(...cTimings)) * 1000,
  };
}

db.close();
try { unlinkSync(dbPath); } catch {}
console.log(JSON.stringify({ read: readOps, write: writeOps, concurrentWrite }));
})();
