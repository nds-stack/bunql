const sqlite3 = require("sqlite3").verbose();
const { mkdirSync, unlinkSync } = require("fs");

const ITERATIONS = 5000;
const WARMUP = 1000;
const RUNS = 5;
const BENCH_DIR = "bench/tmp";

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function openDB(path) {
  return new sqlite3.Database(path);
}

function setupDB(db) {
  return new Promise((resolve) => {
    db.serialize(() => {
      db.run("PRAGMA journal_mode=WAL");
      db.run("PRAGMA synchronous=NORMAL");
      db.run("PRAGMA cache_size=-2000");
      db.run("PRAGMA foreign_keys=ON");
      db.run("CREATE TABLE bench (id INTEGER PRIMARY KEY, val TEXT)");
      const ins = db.prepare("INSERT INTO bench (val) VALUES (?)");
      for (let i = 0; i < WARMUP; i++) ins.run(`seed-${i}`);
      ins.finalize();
      const rd = db.prepare("SELECT * FROM bench WHERE id = ?");
      for (let i = 0; i < WARMUP; i++) rd.get((i % WARMUP) + 1);
      rd.finalize();
      resolve();
    });
  });
}

(async () => {
try { mkdirSync(BENCH_DIR, { recursive: true }); } catch {}

const dbPath = `${BENCH_DIR}/node_sql3_${Date.now()}.db`;

// --- Read Benchmark ---
const dbRead = openDB(dbPath);
await setupDB(dbRead);

const rTimings = [];
for (let r = 0; r < RUNS; r++) {
  await new Promise((resolve) => {
    const rd = dbRead.prepare("SELECT * FROM bench WHERE id = ?");
    const start = performance.now();
    let done = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      rd.get((i % WARMUP) + 1, () => { if (++done === ITERATIONS) { rTimings.push(performance.now() - start); rd.finalize(); resolve(); } });
    }
  });
}
dbRead.close();
const readOps = {
  median: (ITERATIONS / median(rTimings)) * 1000,
  min: (ITERATIONS / Math.max(...rTimings)) * 1000,
  max: (ITERATIONS / Math.min(...rTimings)) * 1000,
};

// --- Write Benchmark (separate DB per run — sqlite3 close is async) ---
const wTimings = [];
for (let r = 0; r < RUNS; r++) {
  const dbWrite = openDB(dbPath);
  await new Promise((resolve) => {
    dbWrite.run("PRAGMA journal_mode=WAL");
    dbWrite.run("PRAGMA synchronous=NORMAL");
    dbWrite.run("PRAGMA cache_size=-2000");
    dbWrite.run("PRAGMA foreign_keys=ON");
    const start = performance.now();
    const ws = dbWrite.prepare("INSERT INTO bench (val) VALUES (?)");
    let done = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      ws.run(`write-${r}-${i}`, () => { if (++done === ITERATIONS) { ws.finalize(); dbWrite.close(() => { wTimings.push(performance.now() - start); resolve(); }); } });
    }
  });
}
const writeOps = {
  median: (ITERATIONS / median(wTimings)) * 1000,
  min: (ITERATIONS / Math.max(...wTimings)) * 1000,
  max: (ITERATIONS / Math.min(...wTimings)) * 1000,
};

try { unlinkSync(dbPath); } catch {}
console.log(JSON.stringify({ read: readOps, write: writeOps, concurrentWrite: {} }));
})();
