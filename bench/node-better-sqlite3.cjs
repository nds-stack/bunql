const Database = require("better-sqlite3");
const { mkdirSync, unlinkSync } = require("fs");

const ITERATIONS = 500;
const BENCH_DIR = "bench/tmp";

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

db.close();
try { unlinkSync(dbPath); } catch {}
console.log(JSON.stringify({ read: readOps, write: writeOps }));
