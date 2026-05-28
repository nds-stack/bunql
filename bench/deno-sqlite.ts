// @ts-nocheck — Deno runtime script, not Bun/Node
import { Database } from "jsr:@db/sqlite@0.13";

const ITERATIONS = 500;

const db = new Database("bench/tmp/deno_sqlite_bench.db");
db.exec("PRAGMA journal_mode=WAL");
db.exec("PRAGMA synchronous=NORMAL");
db.exec("PRAGMA cache_size=-2000");
db.exec("PRAGMA foreign_keys=ON");
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

try { Deno.removeSync("bench/tmp/deno_sqlite_bench.db"); } catch {}
try { Deno.removeSync("bench/tmp/deno_sqlite_bench.db-wal"); } catch {}
try { Deno.removeSync("bench/tmp/deno_sqlite_bench.db-shm"); } catch {}

console.log(JSON.stringify({ read: readOps, write: writeOps }));
