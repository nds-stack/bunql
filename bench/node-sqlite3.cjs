const sqlite3 = require("sqlite3").verbose();
const { mkdirSync, unlinkSync } = require("fs");

const ITERATIONS = 500;
const BENCH_DIR = "bench/tmp";

try { mkdirSync(BENCH_DIR, { recursive: true }); } catch {}

const dbPath = `${BENCH_DIR}/node_sql3_${Date.now()}.db`;
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);

db.serialize();
db.run("PRAGMA journal_mode=WAL");
db.run("PRAGMA synchronous=NORMAL");
db.run("PRAGMA cache_size=-2000");
db.run("PRAGMA foreign_keys=ON");
db.run("CREATE TABLE bench (id INTEGER PRIMARY KEY, val TEXT)");

const insert = db.prepare("INSERT INTO bench (val) VALUES (?)");
for (let i = 0; i < ITERATIONS; i++) insert.run(`value-${i}`);
insert.finalize();

const read = db.prepare("SELECT * FROM bench WHERE id = ?");
read.get(1);

const readStart = performance.now();
for (let i = 0; i < ITERATIONS; i++) read.get((i % ITERATIONS) + 1);
const readOps = (ITERATIONS / (performance.now() - readStart)) * 1000;
read.finalize();

const writeStart = performance.now();
const writeStmt = db.prepare("INSERT INTO bench (val) VALUES (?)");
for (let i = 0; i < ITERATIONS; i++) writeStmt.run(`write-${i}`);
const writeOps = (ITERATIONS / (performance.now() - writeStart)) * 1000;
writeStmt.finalize();

db.close();
try { unlinkSync(dbPath); } catch {}
console.log(JSON.stringify({ read: readOps, write: writeOps }));
