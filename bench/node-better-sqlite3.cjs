const { mkdirSync, unlinkSync } = require("fs");
const Database = require("C:/laragon/bin/nodejs/node-v22/node_modules/better-sqlite3/lib/index.js");

const ITERATIONS = 500;
const CONCURRENCY = [10, 50];
const BENCH_DIR = "bench/tmp";

(async () => {
try { mkdirSync(BENCH_DIR, { recursive: true }); } catch {}

const dbPath = `${BENCH_DIR}/node_bs3_${Date.now()}.db`;
const db = new Database(dbPath);
db.pragma("journal_mode=WAL");
db.pragma("synchronous=NORMAL");
db.pragma("cache_size=-2000");
db.pragma("foreign_keys=ON");
db.exec("CREATE TABLE bench (id INTEGER PRIMARY KEY, val TEXT)");

const insert = db.prepare("INSERT INTO bench (val) VALUES (?)");
for (let i = 0; i < ITERATIONS; i++) insert.run(`value-${i}`);

const read = db.prepare("SELECT * FROM bench WHERE id = ?");
read.get(1);

const readStart = performance.now();
for (let i = 0; i < ITERATIONS; i++) read.get((i % ITERATIONS) + 1);
const readOps = (ITERATIONS / (performance.now() - readStart)) * 1000;

const writeStart = performance.now();
for (let i = 0; i < ITERATIONS; i++) insert.run(`write-${i}`);
const writeOps = (ITERATIONS / (performance.now() - writeStart)) * 1000;

const concurrentWrite = {};
for (const level of CONCURRENCY) {
  const start = performance.now();
  const tasks = [];
  for (let i = 0; i < ITERATIONS; i++) {
    tasks.push(new Promise((resolve) => {
      setImmediate(() => {
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            insert.run(`bs3-conc-${level}-${i}`);
            resolve(); return;
          } catch { /* BUSY */ }
        }
        resolve();
      });
    }));
  }
  await Promise.all(tasks);
  concurrentWrite[level] = (ITERATIONS / (performance.now() - start)) * 1000;
}

db.close();
try { unlinkSync(dbPath); } catch {}
console.log(JSON.stringify({ read: readOps, write: writeOps, concurrentWrite }));
})();
