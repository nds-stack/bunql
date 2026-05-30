<p align="center">
  <picture>
    <source srcset=".docs/images/banner.webp" type="image/webp">
    <img src=".docs/images/banner.webp" alt="BunQL" width="800">
  </picture>
</p>

# @nds-stack/bunql

> **Bun Query Language** — Write SQL or MQL, run on SQLite, MongoDB, Redis, PostgreSQL, MySQL. One query, all backends.

[![npm version](https://img.shields.io/npm/v/%40nds-stack%2Fbunql?color=blue&logo=npm)](https://www.npmjs.com/package/@nds-stack/bunql)
[![Bun](https://img.shields.io/badge/Bun-%3E%3D1.3.0-black?logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue?logo=typescript)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-424-green)]()
[![Bundle](https://img.shields.io/badge/bundle-112.9KB%20core%20%2F%20134.7KB%20driver-blue)]()

---

## Table of Contents

- [Supported Backends](#supported-backends)
- [Why bunql](#why-bunql)
- [How It Works](#how-it-works)
- [Design Goals](#design-goals)
- [When to Use](#when-to-use)
- [When Not to Use](#when-not-to-use)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Examples](#examples)
  - [Bidirectional: SQL on MongoDB](#bidirectional-sql-on-mongodb)
  - [Bidirectional: MQL on SQLite](#bidirectional-mql-on-sqlite)
  - [Statement Format Control](#statement-format-control)
  - [Permanent Parameter Binding](#permanent-parameter-binding)
  - [Lazy Iteration + Class Mapping](#lazy-iteration--class-mapping)
  - [Verbose SQL Logging](#verbose-sql-logging)
  - [PRAGMA Convenience](#pragma-convenience)
  - [Transaction Modes](#transaction-modes)
  - [Exec (Multi-Statement SQL)](#exec-multi-statement-sql)
  - [Batch Inside Transaction](#batch-inside-transaction)
  - [Raw Database Access](#raw-database-access)
  - [Reader Pool (Parallel Reads)](#reader-pool-parallel-reads)
  - [FTS5 Full-Text Search](#fts5-full-text-search)
  - [Maintenance & Auto-Scheduling](#maintenance--auto-scheduling)
  - [Database Serialization](#database-serialization)
- [API](#api)
- [Architecture](#architecture)
- [Compared to Raw bun:sqlite](#compared-to-raw-bunsqlite)
- [Customization](#customization)
- [Benchmarks](#benchmarks)
- [Error Handling](#error-handling)
- [Limitations](#limitations)
- [Multi-Instance / Cross-Process](#multi-instance--cross-process)
- [Stability](#stability)
- [License](#license)

---

## Supported Backends

| Backend | Status | Auto-detect | Driver |
|---------|--------|-------------|--------|
| **SQLite** | ✅ Production (v0.3.0) | `./app.db`, `:memory:` | `bun:sqlite` native |
| **MongoDB** | ✅ Production (via driver subpath) | `mongodb://localhost:27017/db` | Custom TCP + BSON (zero deps) — Bun has no built-in MongoDB driver |
| **Redis** | ✅ Production (via driver subpath) | `redis://localhost:6379` | Custom TCP + RESP (zero deps) — Bun has no built-in Redis driver |
| **PostgreSQL** | ✅ Production (via driver subpath) | `postgres://localhost:5432/db` | Custom TCP + wire protocol (zero deps). Bun also has built-in PG via `new SQL()` |
| **MySQL** | ✅ Production (via driver subpath) | `mysql://localhost:3306/db` | Custom TCP + wire protocol (zero deps). Bun also has built-in MySQL via `new SQL()` |

```typescript
import { BunQL } from "@nds-stack/bunql";
import { MongoDriver } from "@nds-stack/bunql/driver";
import { RedisDriver } from "@nds-stack/bunql/driver";
import { PGDriver } from "@nds-stack/bunql/driver";
import { MySQLDriver } from "@nds-stack/bunql/driver";

// Each backend has its own driver class
const db = new BunQL("./app.db");                    // → SQLite via bun:sqlite
const dbMem = new BunQL(":memory:");                 // → SQLite in-memory
const mongo = new MongoDriver("mongodb://localhost:27017/mydb");
const redis = new RedisDriver("redis://localhost:6379");
const pg = new PGDriver("postgres://localhost:5432/mydb");
const mysql = new MySQLDriver("mysql://localhost:3306/mydb");
```

## Why bunql

### One query, any backend

Bunql translates queries through a **Universal AST** — write SQL, run on MongoDB. Write MongoDB-style queries, run on SQLite. Same API, different backends.

| Write this | Runs on |
|------------|---------|
| `db.query("SELECT name FROM users WHERE age > 25")` | SQLite, MongoDB, PostgreSQL, MySQL |
| `db.mql("users").find({ age: { $gt: 25 } })` | SQLite, MongoDB, PostgreSQL, MySQL |

### Zero-dependency drivers

MongoDB and Redis drivers are built from scratch — TCP via `Bun.connect()`, custom BSON/RESP codec. No `npm mongodb`, no `ioredis`. Bun has no built-in MongoDB or Redis driver.

PostgreSQL and MySQL drivers are also custom implementations via `Bun.connect()`, offering an alternative to Bun's built-in `new SQL()` module with the same unified API across all backends and support for the Universal AST translation pipeline.

### Dual API: Raw SQL + Query Builder

```typescript
const db = new BunQL("./app.db");

// Raw SQL — maximum throughput (production, v0.3.0)
db.run("INSERT INTO users (name) VALUES (?)", ["Alice"]);
const users = db.query("SELECT * FROM users WHERE active = ?", [true]);

// Tagged template SQL — type-safe query builder
const rows = db.sql`SELECT * FROM users WHERE age > ${18} AND active = ${true}`.all();
const single = db.sql`SELECT * FROM users WHERE id = ${1}`.get();

// MongoDB-style MQL chain — runs on SQLite via translation
db.mql("users").find({ age: { $gt: 25 }, active: true }).sort({ name: 1 }).limit(10).toArray();
db.mql("users").insertOne({ name: "Bob", email: "b@t.com" });
```

### Beyond bun:sqlite parity

| Raw `bun:sqlite` | `@nds-stack/bunql` |
|---|---|
| Manual BEGIN/COMMIT/ROLLBACK | `db.transaction(cb)` — 3 lock modes, SAVEPOINT nesting |
| Manual statement lifecycle | LRU cache (100), auto-finalize on close |
| Objects only (`.all()`) | `.raw()` (arrays), `.pluck()` (scalar), `.as()` (class map), `.iterate()` |
| No observability | `db.metrics`, `db.cacheStats`, slow query, verbose tracing |
| No reader pool | `readerPool: N` — round-robin parallel reads |
| bun:sqlite only | bun:sqlite + MongoDB + Redis + PostgreSQL + MySQL |
| Manual PRAGMA loops | `db.pragma("key", { simple: true })` |
| Raw errors | Typed `BunQLError` hierarchy with `.cause` |
| No auto-maintenance | Scheduled WAL checkpoint, vacuum, backup |
| Node.js polyfills | Bun-native: `Bun.file()`, `Bun.connect()`, `Bun.sleep()` |

---

## How It Works

```
                       ┌──────────────────────────┐
                       │      Universal AST         │
                       │   Select | Insert | Update │
                       │   Delete | Aggregate       │
                       └──────────┬───────────────┘
                   ↗             │               ↖
          sql-parser.ts    AST → backend      mql-parser.ts
          (SQL → AST)      translators       (MQL → AST)
              ↗             │    │    │         ↖
      ┌──────────┐   ┌──────┐ ┌──┐ ┌──────┐   ┌──────────┐
      │ SQL text │   │SQLite│ │MG│ │Redis │   │ MQL obj  │
      └──────────┘   └──────┘ └──┘ └──────┘   └──────────┘
```

### Pipeline

1. **Parse** — SQL text → tokens → AST (hand-written recursive descent, zero deps)
2. **Cache** — AST hash → cached SQL string (skip generation on repeated identical queries)
3. **Translate** — AST → dialect-specific SQL or native commands
4. **Execute** — Via driver: `bun:sqlite` (native), TCP + BSON (custom MongoDB), TCP + RESP (custom Redis), custom PG/MySQL wire protocol

### Bidirectional example

```typescript
// Direction 1: SQL → MongoDB
const mongo = new BunQL("mongodb://localhost/mydb");
mongo.query("SELECT name FROM users WHERE age > 25 LIMIT 10");
// Internal: SQL → AST → find({age:{$gt:25}},{projection:{name:1}}).limit(10)

// Direction 2: MQL → SQLite
const sqlite = new BunQL("./app.db");
sqlite.mql("users").find({ age: { $gt: 25 } }).limit(10);
// Internal: MQL → AST → SELECT name FROM users WHERE age > 25 LIMIT 10
```

## Design Goals

- **One Query Language** — SQL or MQL, any backend. No context switching.
- **Zero dependency drivers** — MongoDB, Redis drivers built from scratch. No npm bloat.
- **Universal AST** — Single intermediate representation for all query languages.
- **Statement format control** — `.raw()`, `.pluck()`, `.as()`, `.bind()`, `.iterate()` — full better-sqlite3 parity.
- **Production-first** — Transaction safety, error chains preserved, graceful shutdown.
- **Bun-native** — `bun:sqlite`, `Bun.connect()`, `Bun.file()`, `Bun.sleep()`. No Node.js polyfills.
- **Observability built-in** — Metrics, cache stats, slow query detection, verbose SQL tracing.

---

## When to Use

- You write SQL but need to query MongoDB or Redis.
- You write MQL (MongoDB Query Language) but need to query SQLite or PostgreSQL.
- You want **one API** that works across all your databases — dev uses SQLite, production uses PostgreSQL.
- You want `.raw()` / `.pluck()` / `.iterate()` / `.as()` on prepared statements — better-sqlite3 parity.
- You want zero-dependency drivers — no `npm mongodb`, no `ioredis`.
- You want auto-maintenance: scheduled WAL checkpoint, vacuum, backup.
- You want a lightweight alternative to heavier database wrappers.
- You need embedded storage for a Bun service, CLI tool, or single-process server.

## When Not to Use

| Scenario | Recommendation |
|----------|---------------|
| **High write throughput with true write concurrency** | SQLite is single-writer. Use PostgreSQL/MySQL for parallel write scaling. |
| **Multi-process access** | Use a client-server database, or coordinate via external locking. |
| **Distributed systems** | SQLite is embedded, MongoDB/Redis/PG are networked. Choose based on your architecture. |
| **Full ORM features needed** | Consider Drizzle or Kysely. bunql is a query engine, not an ORM. |
| **Node.js / Deno runtime** | bunql is Bun-only. Use better-sqlite3 for Node.js, drizzle for Deno. |
| **MongoDB advanced features** | `$geoNear`, `$text`, `$facet`, `$graphLookup` not covered — these are MongoDB-specific. |

---

## Installation

```bash
bun add @nds-stack/bunql
```

## Quick Start

```typescript
import { BunQL } from "@nds-stack/bunql";

const db = new BunQL("./app.db");

// Create table
db.run(
  "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT)"
);

// Insert
db.run("INSERT INTO users (name) VALUES (?)", ["Alice"]);

// Query (synchronous, uses statement cache)
const users = db.query<{ id: number; name: string }>(
  "SELECT * FROM users WHERE name = ?",
  ["Alice"]
);
// → { rows: [{ id: 1, name: "Alice" }], columns: ["id", "name"], durationMs: 0.12 }

// Transaction (atomatically rolls back on error)
await db.transaction(async (tx) => {
  tx.run("INSERT INTO users (name) VALUES (?)", ["Bob"]);
  tx.run("INSERT INTO users (name) VALUES (?)", ["Charlie"]);
});

// Prepared statement (cached, reusable)
const stmt = db.prepare<{ id: number; name: string }, [string]>(
  "SELECT * FROM users WHERE name = ?"
);
const bob = stmt.get("Bob");

// Batch (atomic multi-write transaction)
await db.batch([
  { sql: "INSERT INTO users (name) VALUES (?)", params: ["Dave"] },
  { sql: "INSERT INTO users (name) VALUES (?)", params: ["Eve"] },
]);

// Exec — multi-statement SQL (schema files, migrations)
await db.exec(`
  CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, msg TEXT);
  INSERT INTO audit VALUES (1, 'migration v2 applied');
`);

// Raw access — direct bun:sqlite for custom PRAGMA / VACUUM
db.raw.run("PRAGMA cache_size=-8000");
db.raw.run("VACUUM");

// Graceful shutdown
await db.close();
```

```typescript
// MongoDB — import via driver subpath
import { MongoDriver } from "@nds-stack/bunql/driver";

const mongo = new MongoDriver("mongodb://localhost:27017/mydb");

// SQL → AST → MongoDB — write SQL, run on MongoDB
const users = await mongo.query(
  "SELECT name, email FROM users WHERE age > ? AND status = ?",
  [25, "active"]
);

// INSERT / UPDATE / DELETE work the same way
await mongo.run("INSERT INTO users (name, email) VALUES ('Alice', 'a@t.com')");

await mongo.close();
```

```typescript
// Redis — import via driver subpath
import { RedisDriver } from "@nds-stack/bunql/driver";

const redis = new RedisDriver("redis://:password@localhost:6379/0");

// SQL → AST → Redis — best performance with WHERE id = X (uses HGETALL)
const user = await redis.query("SELECT * FROM users WHERE id = 1");
// → HGETALL users:1

// INSERT with id column → HSET
await redis.run("INSERT INTO users (id, name, email) VALUES (2, 'Bob', 'b@t.com')");
// → HSET users:2 name Bob email b@t.com

await redis.close();
```

```typescript
// PostgreSQL — import via driver subpath
import { PGDriver } from "@nds-stack/bunql/driver";

const pg = new PGDriver("postgres://user:pass@localhost:5432/mydb");

// SQL → PG wire protocol — use $1, $2 placeholders (PostgreSQL style)
const users = await pg.query(
  "SELECT name, email FROM users WHERE age > $1",
  [25]
);

await pg.run("INSERT INTO users (name, email) VALUES ($1, $2)", ["Alice", "a@t.com"]);

await pg.close();
```

```typescript
// MySQL — import via driver subpath
import { MySQLDriver } from "@nds-stack/bunql/driver";

const mysql = new MySQLDriver("mysql://user:pass@localhost:3306/mydb");

const users = await mysql.query(
  "SELECT name, email FROM users WHERE age > ?",
  [25]
);

await mysql.run("INSERT INTO users (name, email) VALUES (?, ?)", ["Alice", "a@t.com"]);

await mysql.close();
```

---

## Examples

### Concurrent Writes

```typescript
import { BunQL } from "@nds-stack/bunql";

const db = new BunQL("./app.db");

// All writes are synchronous and sequential — no queue, no retry
for (let i = 0; i < 100; i++) {
  db.run("INSERT INTO logs (message) VALUES (?)", [`event-${i}`]);
}
// All 100 writes succeed — direct stmt.run() on each call.
```

### Transaction with Error Recovery

```typescript
import { BunQL } from "@nds-stack/bunql";

const db = new BunQL("./app.db");

try {
  await db.transaction(async (tx) => {
    tx.run("UPDATE accounts SET balance = balance - 100 WHERE id = 1");
    tx.run("UPDATE accounts SET balance = balance + 100 WHERE id = 2");
  });
} catch (error) {
  // Original error is re-thrown directly — no TransactionError wrapper
  console.error("Transaction failed:", error);
}
```

### Event Monitoring

```typescript
import { BunQL } from "@nds-stack/bunql";

const db = new BunQL("./app.db", {
  retry: { maxRetries: 3 },
  slowQueryThreshold: 100,
  events: {
    onBusy: (attempt, delayMs) => {
      console.log(`Busy, retrying in ${delayMs}ms (attempt ${attempt + 1})`);
    },
    onDrain: () => console.log("Write queue drained"),
    onError: (err) => console.error("Operation failed:", err),
    onSlowQuery: (sql, ms) => console.warn(`Slow query (${ms}ms):`, sql),
  },
});
```

### Exec (Multi-Statement SQL)

Load a `.sql` schema file containing multiple statements:

```typescript
import { BunQL } from "@nds-stack/bunql";

const db = new BunQL("./app.db");

// Load schema file
const schema = await Bun.file("./schema.sql").text();
await db.exec(schema);
```

### Batch Inside Transaction

```typescript
import { BunQL } from "@nds-stack/bunql";

const db = new BunQL("./app.db");

await db.transaction(async (tx) => {
  await tx.batch([
    { sql: "INSERT INTO users (name) VALUES (?)", params: ["Alice"] },
    { sql: "INSERT INTO users (name) VALUES (?)", params: ["Bob"] },
  ]);
});
```

### Raw Database Access

Direct access to the `bun:sqlite` `Database` instance for PRAGMA or operations not covered by the API:

```typescript
import { BunQL } from "@nds-stack/bunql";
import type { Database } from "bun:sqlite";

const db = new BunQL("./app.db");

// Get the raw Database instance directly
const raw: Database = db.raw;
raw.run("PRAGMA cache_size=-8000");
raw.run("PRAGMA synchronous=FULL");
raw.exec("VACUUM");
```

### Reader Pool (Parallel Reads)

Multiple read-only connections untuk parallel reads:

```typescript
import { BunQL } from "@nds-stack/bunql";

// Pool of 3 read-only connections, round-robin
const db = new BunQL("./app.db", { readerPool: 3 });

// Reads are automatically distributed — parallel safe
const users = db.query("SELECT * FROM users");
const posts = db.query("SELECT * FROM posts");

await db.close();
```

### FTS5 Full-Text Search

Full-text search via built-in SQLite FTS5 (no additional dependencies):

```typescript
import { BunQL } from "@nds-stack/bunql";

const db = new BunQL("./app.db");

// Setup (synchronous — no await needed)
db.fts.create("articles", ["title", "body"]);

// Insert
db.fts.insert("articles", {
  title: "Hello SQLite",
  body: "SQLite FTS5 is a powerful full-text search engine",
});

// Search with ranking + snippet
const results = db.fts.search("articles", "sqlite", {
  limit: 10,
  snippet: { startTag: "<b>", endTag: "</b>" },
});

// Index maintenance (synchronous)
db.fts.optimize("articles");
db.fts.rebuild("articles");
db.fts.drop("articles");
```

### Maintenance & Auto-Scheduling

```typescript
import { BunQL } from "@nds-stack/bunql";

const db = new BunQL("./app.db", {
  maintenance: {
    checkpoint: { enabled: true, intervalMs: 60000, pagesThreshold: 1000, mode: "TRUNCATE" },
    vacuum: { enabled: true, intervalMs: 60000, mode: "incremental", pagesPerStep: 100 },
    backup: { enabled: true, intervalMs: 86_400_000, path: "./backups/" },
  },
  slowQueryThreshold: 100,  // ms — log queries slower than this
  events: {
    onSlowQuery: (sql, ms) => console.warn(`Slow query (${ms}ms):`, sql),
  },
});
```

### Vacuum

```typescript
import { BunQL } from "@nds-stack/bunql";

const db = new BunQL("./app.db");

// Full vacuum (blocking)
await db.vacuum();

// Incremental vacuum (non-blocking, page-at-a-time)
const result = await db.vacuum({ incremental: true, pagesPerStep: 100 });
console.log(`Reclaimed ${result.pagesReclaimed} pages`);
```

### Bidirectional: SQL on MongoDB

Write SQL, bunql translates to MongoDB wire protocol:

```typescript
const mongo = new BunQL("mongodb://localhost:27017/mydb");

// SQL written by developer — executed as MongoDB find() internally
const users = mongo.query("SELECT name, email FROM users WHERE age > 25 LIMIT 10");
// → find({age:{$gt:25}}, {projection:{name:1,email:1}}).limit(10)

// INSERT SQL → insertOne
mongo.run("INSERT INTO users (name, email) VALUES ('Alice', 'a@t.com')");
// → insertOne({name:"Alice", email:"a@t.com"})

// GROUP BY → MongoDB aggregation pipeline
const stats = mongo.query(
  "SELECT status, COUNT(*) as total FROM orders GROUP BY status"
);
// → aggregate([{$group:{_id:"$status", count:{$count:{}}}}])
```

### Bidirectional: MQL on SQLite

Write MongoDB-style queries, runs on SQLite via translation:

```typescript
const sqlite = new BunQL("./app.db");

// MongoDB-style find → SQL SELECT
const users = sqlite.mql("users")
  .find({ age: { $gt: 25 } })
  .project({ name: 1, email: 1 })
  .sort({ name: 1 })
  .limit(10);

// → SELECT name, email FROM users WHERE age > 25 ORDER BY name ASC LIMIT 10

// MongoDB-style aggregate → SQL GROUP BY
const stats = sqlite.mql("orders").aggregate([
  { $group: { _id: "$status", count: { $count: {} } } },
  { $sort: { count: -1 } },
]);
// → SELECT status, COUNT(*) as count FROM orders GROUP BY status ORDER BY count DESC

// CRUD
sqlite.mql("users").insertOne({ name: "Bob", email: "b@t.com" });
sqlite.mql("users").updateOne({ _id: 1 }, { $set: { name: "Robert" } });
sqlite.mql("users").deleteOne({ _id: 1 });
```

### Statement Format Control

Raw mode (arrays instead of objects) and pluck mode (first column only):

```typescript
import { BunQL } from "@nds-stack/bunql";

const db = new BunQL(":memory:");
db.run("CREATE TABLE users (id INTEGER, name TEXT)");
db.run("INSERT INTO users VALUES (1, 'Alice'), (2, 'Bob')");

// raw() — returns arrays instead of objects
const rows = db.prepare("SELECT * FROM users ORDER BY id").raw().all();
// → [[1, "Alice"], [2, "Bob"]]

// pluck() — returns first column value only
const ids = db.prepare("SELECT id FROM users ORDER BY id").pluck().all();
// → [1, 2]
```

### Permanent Parameter Binding

```typescript
const stmt = db.prepare<{ name: string }>("SELECT name FROM users WHERE id = ?");
stmt.bind(1);
const alice = stmt.get();  // uses bound value → { name: "Alice" }
const bob = stmt.get(2);   // overrides bound value → { name: "Bob" }
```

### Lazy Iteration + Class Mapping

```typescript
// iterate() yields rows one by one — memory-efficient for large results
for (const row of db.prepare("SELECT * FROM users").iterate()) {
  console.log(row);
}

// as() maps rows to class instances (prototype assignment)
class User {
  id!: number;
  name!: string;
  get displayName() { return `User: ${this.name}`; }
}
const user = db.prepare("SELECT * FROM users WHERE id = 1").as(User).get();
console.log(user?.displayName);  // → "User: Alice"
```

### Verbose SQL Logging

```typescript
// true — logs every SQL via the logger (debug level)
const db1 = new BunQL("./app.db", { verbose: true });

// custom callback
const sqls: string[] = [];
const db2 = new BunQL("./app.db", { verbose: (sql) => sqls.push(sql) });
```

### PRAGMA Convenience

```typescript
// Structured rows
const ver = db.pragma("user_version");       // → [{ user_version: 0 }]

// Scalar with { simple: true }
const pz = db.pragma("page_size", { simple: true });  // → 4096
```

### Transaction Modes

```typescript
// Default: "immediate" (configurable via `transactionMode` option)
await db.transaction(async (tx) => {
  tx.run("INSERT INTO users VALUES (3, 'Charlie')");
});

// Explicit mode: deferred | immediate | exclusive
await db.transaction(async (tx) => { /* ... */ }, "exclusive");
await db.transaction(async (tx) => { /* ... */ }, "deferred");
```

### Database Serialization

```typescript
const buf = db.serialize();          // → Uint8Array
const db2 = BunQL.deserialize(buf);  // → new BunQL instance
```

---

## API

### Constructor

```typescript
new BunQL(path: string, options?: BunQLOptions)
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `wal` | `boolean` | `true` | Enable WAL journal mode |
| `metricsEnabled` | `boolean` | `false` | Enable performance counters and timing. Set `true` to track writes/reads/durationMs. |
| `extractColumns` | `boolean` | `false` | Extract column names via `Object.keys(rows[0])`. Set `true` if you need column metadata. |
| `queryTimeoutMs` | `number` | `0` | Interrupt queries exceeding this duration. `0` = disabled. |
| `busyTimeout` | `number` | `5000` | SQLite busy timeout (ms) |
| `synchronous` | `'OFF' \| 'NORMAL' \| 'FULL' \| 'EXTRA'` | `'NORMAL'` | Synchronous mode (NORMAL recommended for WAL) |
| `cacheSize` | `number` | `-2000` | Page cache size (negative = KB, -2000 = 2MB) |
| `foreignKeys` | `boolean` | `true` | Enforce FOREIGN KEY constraints |
| `retry` | `RetryConfig` | — | Retry policy for SQLITE_BUSY (transaction/batch/exec/backup/vacuum only — `run()` bypasses retry) |
| `safeIntegers` | `boolean` | `false` | Passthrough to `bun:sqlite`. Returns `INTEGER` columns as `BigInt` instead of `number`. |
| `verbose` | `boolean \| (sql: string) => void` | `false` | Log every SQL statement. `true` = via logger, function = custom callback. |
| `transactionMode` | `TransactionMode` | `"immediate"` | Default transaction start: `"deferred"` \| `"immediate"` \| `"exclusive"`. |
| `readerPool` | `number` | `0` | Number of read-only connections for parallel reads (`0` = disabled) |
| `maintenance` | `MaintenanceConfig` | — | Auto-scheduler for checkpoint, vacuum, backup, integrity check |
| `slowQueryThreshold` | `number` | `0` | Slow query threshold in ms (`0` = disabled). Triggers `onSlowQuery` event |
| `pragma` | `{ autoVacuum? }` | — | PRAGMA options like `autoVacuum` |
| `logger` | `Logger` | — | Logger (`console`-compatible) |
| `hooks` | `BunQLHooks` | — | Lifecycle callbacks |
| `events` | `EventHandlers` | — | Event handlers (includes `onSlowQuery`) |

### RetryConfig

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxRetries` | `number` | `5` | Maximum retry attempts |
| `baseDelay` | `number` | `50` | Base delay (ms). Actual delay: `baseDelay × 2^attempt` |
| `maxDelay` | `number` | `1000` | Maximum delay cap |
| `jitter` | `boolean` | `true` | Random ±50% jitter on delay |

### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `query(sql, params?)` | `QueryResult<T>` | Read query. Parallel-safe, uses statement cache. |
| `querySync(sql, params?)` | `QueryResult<T>` | Synchronous read (fast path). No reader pool. |
| `run(sql, params?)` | `RunResult` | Write query. Synchronous — direct `stmt.run()`. |
| `transaction(callback)` | `Promise<T>` | Serialized transaction. Auto-rollback on error. |
| `prepare(sql)` | `Statement<T, P>` | Cached prepared statement. See [Statement API](#statement-api) for full method list. |
| `pragma(source, opts?)` | `unknown` | PRAGMA query convenience. `{ simple: true }` returns first column of first row. |
| `serialize()` | `Uint8Array` | Serialize entire DB to bytes. Reload via `BunQL.deserialize()`. |
| `batch(operations)` | `Promise<RunResult[]>` | Atomic multi-write transaction. |
| `exec(sql)` | `Promise<void>` | Multi-statement SQL (schema files, migrations). Serialized via queue. |
| `walStatus()` | `Promise<WalStatus>` | WAL file size, page info, checkpoint requirement. |
| `checkpoint(mode)` | `Promise<CheckpointResult>` | Explicit WAL checkpoint (PASSIVE \| FULL \| RESTART \| TRUNCATE). |
| `backup(path)` | `Promise<BackupResult>` | Online backup via `VACUUM INTO`. Safe, queue-aware. |
| `raw` | `Database` | Getter — direct access to the underlying `bun:sqlite` instance. |
| `fts` | `FTS5Helper` | Getter — FTS5 search helper (create, search, insert, delete, update, rebuild, merge, optimize, drop). |
| `metrics` | `BunQLMetrics` | Getter — real-time operation counters (writes, reads, txs, queue). |
| `cacheStats` | `CacheStats` | Getter — statement cache hit/miss/size/rate. |
| `name` | `string` | Getter — database filename or `":memory:"`. |
| `memory` | `boolean` | Getter — true if database is in-memory. |
| `readonly` | `boolean` | Getter — true if opened with `readonly: true`. |
| `inTransaction` | `boolean` | Getter — true if currently inside an active transaction. |
| `vacuum(opts?)` | `Promise<VacuumResult>` | Full or incremental vacuum. Returns reclaimed pages count. |
| `close()` | `Promise<void>` | Graceful shutdown. Drains queue, finalizes statements, closes DB. |

### Static Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `BunQL.deserialize(buf, opts?)` | `BunQL` | Create a new BunQL instance from a serialized database buffer. |

### Result Types

```typescript
interface QueryResult<T> {
  rows: T[];
  columns: string[];       // empty array unless extractColumns: true
  durationMs: number;       // 0 unless metricsEnabled: true
}

interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint | null;
  durationMs: number;       // 0 unless metricsEnabled: true
}

interface ColumnInfo {
  name: string;             // column alias or name
  column: string | null;    // originating column (null for expressions)
  table: string | null;     // originating table (null for expressions)
  database: string | null;  // originating database (null for expressions)
  type: string | null;      // declared type from schema
}
```

### Statement API

```typescript
interface Statement<T, P extends unknown[]> {
  // Execution
  all(...params: P): T[];
  get(...params: P): T | undefined;
  run(...params: P): RunResult;
  values(...params: P): unknown[][];
  iterate(...params: P): IterableIterator<T>;
  finalize(): void;

  // Format control (chainable — mutually exclusive raw/pluck)
  raw(toggle?: boolean): Statement<unknown[], P>;
  pluck(toggle?: boolean): Statement<unknown, P>;

  // Metadata
  columns(): ColumnInfo[];

  // Parameter binding
  bind(...params: P): Statement<T, P>;

  // Integer handling
  safeIntegers(toggle?: boolean): Statement<T, P>;

  // Class mapping
  as<U>(Class: new (...args: unknown[]) => U): Statement<U, P>;

  // Properties
  readonly source: string;   // original SQL text
  readonly reader: boolean;  // true for SELECT / WITH / PRAGMA
}

interface BunQLMetrics {
  writes: { total: number; failed: number; retried: number };
  reads: { total: number };
  queue: { currentSize: number; peakSize: number; totalEnqueued: number };
  transactions: { committed: number; rolledBack: number };
}

interface CacheStats {
  size: number;
  hits: number;
  misses: number;
  hitRate: number;
}

interface WalStatus {
  walSizePages: number;
  pageSize: number;
  pageCount: number;
  checkpointRequired: boolean;
  lastCheckpointPages: number;
}

interface CheckpointResult {
  pagesCheckpointed: number;
  walSizeBytes: number;
}

interface BackupResult {
  size: number;
  durationMs: number;
}

interface VacuumResult {
  pagesReclaimed: number;
  durationMs: number;
}

interface FTSResult {
  rank: number;
  [column: string]: unknown;
}
```



## Architecture

### Universal Query Engine

```
                       ┌──────────────────────────┐
                       │      Universal AST         │
                       │   Select | Insert | Update │
                       │   Delete | Aggregate       │
                       └──────────┬───────────────┘
                   ↗             │               ↖
          sql-parser.ts    AST → backend      mql-parser.ts
          (SQL → AST)      translators       (MQL → AST)
              ↗             │    │    │         ↖
      ┌──────────┐   ┌──────┐ ┌──┐ ┌──────┐   ┌──────────┐
      │ SQL text │   │SQLite│ │MG│ │Redis │   │ MQL obj  │
      └──────────┘   └──────┘ └──┘ └──────┘   └──────────┘
                      to-sql  to-mongo  to-redis
```

### SQLite (Raw API — production)

```
 User Code
     │
     ▼
 ┌──────────────────────────────────────────────────┐
 │  db.run()    db.query()    db.transaction()  raw  │
 │  (sync)      (sync)       (async)          (get)  │
 └──────┬──────────┬──────────────┬──────────────┬───┘
        │          │              │              │
        ▼          ▼              ▼              ▼
 ┌──────────┐ ┌──────────┐ ┌────────────┐ ┌──────────┐
 │Statement │ │Statement │ │ WriteQueue │ │   raw    │
 │ Cache    │ │ Cache    │ │ tx/batch/  │ │  direct  │
 │(LRU/100) │ │ (+pool)  │ │ exec       │ │  access  │
 └────┬─────┘ └────┬─────┘ └─────┬──────┘ └────┬─────┘
      │            │              │             │
      └────────────┴──────────────┴─────────────┘
                       │
                       ▼
              ┌─────────────────┐
              │  bun:sqlite     │
              │  + WAL + PRAGMA │
              └─────────────────┘
```

### Pipeline: SQL on MongoDB

```
User: db.query("SELECT name FROM users WHERE age > 25 LIMIT 10")
  │
  ▼
sql-parser.ts  →  AST  →  to-mongodb.ts  →  MongoCommand
  │                    │                        │
  │                    │                        ▼
  │                    │              { collection: "users",
  │                    │                method: "find",
  │                    │                args: [{age:{$gt:25}}, {projection:{name:1},limit:10}] }
  │                    │
  │              Cache layers:
  │              1. AST hash → SQL string (skip generation)
  │              2. SQL string → compiled stmt (StatementCache LRU/100)
  │              3. SQL string → MongoCommand (skip translation)
  ▼
Bun.connect() TCP → MongoDB server → BSON decoded → rows
```

### Pipeline: MQL on SQLite

```
User: db.mql("users").find({age:{$gt:25}}).project({name:1}).limit(10)
  │
  ▼
mql-parser.ts  →  AST  →  to-sql.ts  →  "SELECT name FROM users WHERE age > ? LIMIT 10"
  │                    │                         │
  │                    │                         ▼
  │                    │               StatementCache.get(sql)
  │                    │                         │
  │                    │                         ▼
  │                    │               stmt.all(25) → rows
  │                    │
  │              Cache layers:
  │              1. AST hash → SQL string
  │              2. SQL string → compiled BunStatement
  ▼
return rows  ← identical format regardless of backend
```

### Write Flow (SQLite)

`run()` is **synchronous** — direct to `bun:sqlite` via statement cache. No WriteQueue, no Promise, no retry:

```
db.run(sql, params)
  → StatementCache.get(sql)
  → stmt.run(params)
  → return { changes, lastInsertRowid }
```

### Transaction Flow (SQLite)

`transaction()`, `batch()`, `exec()` go through **WriteQueue** — the only operations that need serialization:

1. Enter WriteQueue (serialized execution order)
2. `BEGIN IMMEDIATE` (default; configurable to `DEFERRED` / `EXCLUSIVE` via mode)
3. Callback receives `TransactionContext` with `run()` / `query()` / `batch()` / `prepare()`
4. Success → `COMMIT`. Failure → `ROLLBACK` (original error re-thrown directly, no wrapper)
5. Nested transactions use SQLite **SAVEPOINT** for isolation

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Universal AST | Single IR for all query languages — enables bidirectional SQL↔NoSQL translation |
| Hand-written parsers | SQL/MQL parsers built from scratch — zero dependencies, < 900 LOC total |
| Custom drivers | MongoDB/Redis built with `Bun.connect()` — zero npm deps. PG/MySQL custom alternative to Bun's native `new SQL()`. |
| SQLite: single DB connection | SQLite is single-writer. Multiple connections don't help writes. |
| `run()` is sync | `bun:sqlite` is sync — wrapping with Promise adds overhead for no benefit. |
| WriteQueue only for tx/batch | Transactions need serialization (BEGIN→COMMIT). Writes don't. |
| 3 transaction modes | `deferred` / `immediate` / `exclusive` — match SQLite's lock semantics. |
| Reads bypass queue | Reads execute directly — never blocked by writes. |
| Dual API (SQL + MQL) | Developer chooses query language. Backend handles translation. |
| 3-level cache | AST hash → SQL string → compiled stmt. Near-raw speed on cache hit. |
| `raw` getter exposed | Direct access to `bun:sqlite` Database for PRAGMA, VACUUM, etc. |
| Original error preserved | Transaction errors re-thrown directly, no wrapper. |

---

## Compared to Raw bun:sqlite

| Aspect | `bun:sqlite` | `@nds-stack/bunql` |
|--------|-------------|-------------------|
| API surface | Low-level, direct | Same SQL, added convenience |
| Write path | `stmt.run()` (sync C binding) | `db.run()` (sync, cached statement) |
| Transactions | Manual BEGIN/COMMIT | Scoped callbacks with auto-rollback + SAVEPOINT + 3 modes |
| Error handling | Raw SQLite errors | Typed `BunQLError` hierarchy; original errors preserved |
| Reads | Direct | Cached (LRU, max 100) |
| Statement format | Objects only | `.raw()` (arrays), `.pluck()` (scalar), `.as()` (class map) |
| Prepared stmts | Manual manage | Auto-cached, reused + `.bind()` + `.iterate()` |
| PRAGMA calls | `db.run("PRAGMA key")` | `db.pragma("key", { simple: true })` |
| Serialization | Manual | `db.serialize()` + `BunQL.deserialize()` |
| Graceful shutdown | Manual | Drain pending ops + cache finalize |
| Backend support | SQLite only | SQLite + MongoDB + Redis + PostgreSQL + MySQL — one query language |
| Bundle size | Built-in | +112.9KB core / +5.2KB server (SQLite) / +134.7KB driver (all backends) |

bunql is not a replacement for `bun:sqlite` — it's an **ergonomic layer** on top. You still write raw SQL. The wrapper handles what `bun:sqlite` leaves bare: transactions, statement lifecycle, observability, graceful shutdown.

---

## Customization

### Logger

Provide any `console`-compatible logger. Defaults to `console`:

```typescript
const db = new BunQL("./app.db", {
  logger: {
    log: (...args) => myLogger.info(args),
    warn: (...args) => myLogger.warn(args),
    error: (...args) => myLogger.error(args),
  },
});
```

### Lifecycle Hooks

Transaction-level hooks for monitoring:

```typescript
const db = new BunQL("./app.db", {
  hooks: {
    beforeTransaction: () => console.log("TX starting"),
    afterTransaction: (success) => console.log(`TX ${success ? "committed" : "rolled back"}`),
  },
});
```

Note: `beforeWrite` / `afterWrite` hooks no longer apply to `run()` since v0.2.0 — writes are synchronous. The hooks still work for `batch()` operations.

### Events

React to transaction/queue events:

```typescript
const db = new BunQL("./app.db", {
  retry: { maxRetries: 5, baseDelay: 50 },
  slowQueryThreshold: 100,
  events: {
    onBusy: (attempt, delayMs) => metrics.increment("db_busy"),   // fires during transactions/queue ops
    onDrain: () => console.log("Queue empty"),                     // fires after tx/batch complete
    onError: (err) => sentry.captureException(err),
    onSlowQuery: (sql, ms) => console.warn(`Slow query (${ms}ms):`, sql),
  },
});
```

### Statement Cache Tuning

The LRU cache holds up to 100 prepared statements. No config knob — the limit is deliberate to prevent unbounded growth. Highly diverse query patterns may trigger evictions; if you consistently see low hit rates in `cacheStats`, consider caching frequently-used queries at the application level.

### Verbose SQL Logging

Log every SQL statement executed — useful for debugging and auditing:

```typescript
// true — logs via the configured logger at debug level
const db = new BunQL("./app.db", { verbose: true });

// custom callback
const db2 = new BunQL("./app.db", {
  verbose: (sql: string) => console.log("[SQL]", sql),
});
```

### Transaction Modes

Control SQLite's lock semantics per transaction:

```typescript
const db = new BunQL("./app.db", {
  transactionMode: "immediate",  // default: prevent concurrent writes
});

// Override per-transaction
await db.transaction(async (tx) => {
  // ...
}, "deferred");   // no lock acquired until first write
await db.transaction(async (tx) => {
  // ...
}, "exclusive");  // exclusive lock on entire database
```

---

## Benchmarks

**Test machine:** Intel i7-7500U @ 2.90GHz, 8GB RAM, Samsung NVMe SSD 238GB, Windows 10 x64

### Custom Drivers vs Bun.SQL

Benchmark of `@nds-stack/bunql` custom TCP drivers (PG, MySQL, MongoDB, Redis) against Bun's native `Bun.SQL` (PG/MySQL only — Bun has no built-in MongoDB or Redis driver), plus SQLite facade overhead:

**Script:** `bench/vs-bun-sql.ts` — 500 iterations, 100 warmup, separate `:memory:` databases for fair SQLite comparison.

| Driver | Operation | Baseline | bunql | Overhead |
|--------|-----------|----------|-------|----------|
| **SQLite** | SELECT (cached stmt) | 193M ops/s (bun:sqlite) | 89M ops/s | 141% |
| **SQLite** | INSERT (parameterized) | 97M ops/s (bun:sqlite) | 87M ops/s | 0% |
| **PG** | SELECT (parameterized) | 3.14M ops/s (Bun.SQL) | 2.48M ops/s | 10% |
| **PG** | INSERT (parameterized) | 1.69M ops/s (Bun.SQL) | 1.26M ops/s | 13% |
| **MySQL** | SELECT (parameterized) | 1.96M ops/s (Bun.SQL) | 1.85M ops/s | 2% |
| **MySQL** | INSERT (parameterized) | 247K ops/s (Bun.SQL) | 236K ops/s | 1% |
| **MongoDB** | SELECT | — | 1.46M ops/s | — |
| **MongoDB** | INSERT | — | 1.30M ops/s | — |
| **Redis** | SELECT | — | — | — |
| **Redis** | INSERT | — | — | — |

> SQLite SELECT overhead comes from BunQL's cache lookup + query parsing + row-to-object mapping. SQLite INSERT overhead is negligible because `run()` passes through directly to `bun:sqlite`. PG overhead comes from extended query protocol (Parse+Bind+Describe+Execute+Sync pipeline). MySQL uses simple COM_QUERY with inline params, keeping overhead under 2%. MongoDB has no baseline since Bun has no built-in MongoDB driver. Redis benchmark was skipped because Redis server was not available on the test machine. Bundle: 112.9KB core / 134.7KB driver / 71.2KB query / 5.2KB server.

---

## Feature Support Matrix

**Legend:** ✅ Fully supported | ⚠️ Partial / experimental | ❌ Not supported | — Not applicable

| Feature | SQLite | PostgreSQL | MySQL | MongoDB | Redis |
|---------|--------|-----------|-------|---------|-------|
| **CRUD** | | | | | |
| SELECT / find | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| INSERT | ✅ | ✅ | ✅ | ✅ | ✅ |
| UPDATE | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| DELETE | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| **WHERE conditions** | | | | | |
| `=`, `<>`, `>`, `<`, `>=`, `<=` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `LIKE` / `NOT LIKE` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `IN` / `NOT IN` | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| `BETWEEN` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `IS NULL` / `IS NOT NULL` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `AND` / `OR` / `NOT` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `$mod` / `$size` / `$type` / `$all` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `$elemMatch` | ⚠️ | ✅ | ⚠️ | ✅ | ❌ |
| `$expr` (field-to-field) | ✅ | ✅ | ✅ | ✅ | ❌ |
| **Advanced SQL** | | | | | |
| `JOIN` (INNER/LEFT/RIGHT/FULL/CROSS/NATURAL) | ✅ | ✅ | ✅ | ✅ | ❌ |
| `GROUP BY` + aggregate functions | ✅ | ✅ | ✅ | ✅ | ❌ |
| `HAVING` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `DISTINCT` / `COUNT(DISTINCT col)` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `ORDER BY` / `LIMIT` / `OFFSET` | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| Subqueries `FROM (SELECT ...)` | ✅ | ✅ | ✅ | ✅ | ❌ |
| CTE `WITH ... AS` | ✅ | ✅ | ✅ | ❌ | ❌ |
| `UNION` / `INTERSECT` / `EXCEPT` | ✅ | ✅ | ✅ | ❌ | ❌ |
| `INSERT ... SELECT` | ✅ | ✅ | ✅ | ✅ | ❌ |
| Arithmetic `+`, `-`, `*`, `/`, `%` | ✅ | ✅ | ✅ | ⚠️ | ❌ |
| `RETURNING` clause | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Aggregate pipeline stages** | | | | | |
| `$match` → `WHERE` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `$group` with accumulators | ✅ | ✅ | ✅ | ✅ | ❌ |
| `$sort` / `$limit` / `$skip` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `$project` (simple + computed) | ⚠️ | ⚠️ | ⚠️ | ✅ | ❌ |
| `$lookup` (simple + complex) | ⚠️ | ⚠️ | ⚠️ | ✅ | ❌ |
| `$unwind` | ❌ | ❌ | ❌ | ✅ | ❌ |
| `$sample` | ⚠️ | ⚠️ | ⚠️ | ✅ | ❌ |
| **MQL operators** | | | | | |
| `$eq`, `$ne`, `$gt`, `$lt`, `$gte`, `$lte` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `$in`, `$nin` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `$regex` + `$options` (wildcard conversion) | ✅ | ✅ | ✅ | ✅ | ❌ |
| `$exists` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `$and`, `$or`, `$not`, `$nor` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `$all`, `$size`, `$mod`, `$type` | ✅ | ⚠️ | ✅ | ✅ | ❌ |
| `$elemMatch`, `$expr` | ⚠️ | ✅ | ⚠️ | ✅ | ❌ |
| **MQL update operators** | | | | | |
| `$set` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `$inc` / `$unset` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `$push` / `$pull` | ⚠️ | ⚠️ | ⚠️ | ✅ | ❌ |
| **MQL accumulators** | | | | | |
| `$sum`, `$avg`, `$min`, `$max`, `$count` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `$push`, `$addToSet` | ⚠️ | ⚠️ | ⚠️ | ✅ | ❌ |
| `$first`, `$last` | ⚠️ | ✅ | ✅ | ✅ | ❌ |
| **DDL** | | | | | |
| `CREATE TABLE` | ✅ | ✅ | ✅ | ❌ | ❌ |
| `DROP TABLE` | ✅ | ✅ | ✅ | ❌ | ❌ |
| **Transactions** | | | | | |
| BEGIN / COMMIT / ROLLBACK | ✅ | ✅ | ✅ | ❌ | ❌ |
| SAVEPOINT nesting | ✅ | ✅ | ✅ | ✅ | ❌ |
| **Connection** | | | | | |
| Connection pooling | ✅ | ✅ | ✅ | ✅ | ✅ |
| Parameterized queries | ✅ | ✅ | ✅ | ✅ | ❌ |
| Raw SQL passthrough | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| **Native dialect** | | | | | |
| Placeholder style | `?` | `$1` | `?` | — | — |
| Identifier quoting | — | `"col"` | `` `col` `` | — | — |

> **Query Builder API** (`@nds-stack/bunql/query`): ✅ All backends — Chainable SQL/MQL builder with unified interface. See [API](#api) for details.

---

## Known Limitations

### Scalar Subqueries
```sql
-- Not yet supported — use JOIN or application-level filtering:
WHERE salary > (SELECT AVG(salary) FROM employees)
```
Use application-level filtering, rewrite as JOIN, or pre-compute values for now.

### Redis Data Types
Redis backend serializes all values to strings. Numbers, booleans, and dates are preserved on read/write within the same Redis instance, but cross-backend queries may require explicit type conversion.

### Backend Asymmetries
| Feature | SQLite | PostgreSQL | MySQL | MongoDB | Redis |
|---------|--------|-----------|-------|---------|-------|
| `RETURNING` clause | ✅ | ✅ | ❌ (<8.0.21) | ❌ | ❌ |
| Window functions | ✅ 3.25+ | ✅ | ✅ 8.0+ | ❌ (<5.0) | ❌ |
| Subquery WHERE | ✅ | ✅ | ✅ | ❌ | ❌ |
| `$type` accuracy | `TYPEOF()` | `1=1` (no-op) | `JSON_TYPE()` | native | ❌ |

### Error Handling
When a feature is not supported by a backend, BunQL throws a typed `BunQLError` with a clear message — no silent failures or wrong results.

---

Errors in bunql follow a typed hierarchy. The original error is always preserved via `cause` — no swallowed errors:

```
BunQLError (base)
├── BusyError         — SQLITE_BUSY / SQLITE_BUSY_SNAPSHOT after retries exhausted
├── TransactionError  — Transaction scope failure (nested SAVEPOINT, etc.)
├── QueueError        — WriteQueue internal failure (closed queue, drain timeout)
└── ConnectionError   — Database open/close failure, invalid path, WAL requirement
```

```typescript
import { BunQL, BusyError, ConnectionError } from "@nds-stack/bunql";

try {
  await db.batch([
    { sql: "INSERT INTO logs (msg) VALUES (?)", params: ["hello"] },
    { sql: "INSERT INTO logs (msg) VALUES (?)", params: ["world"] },
  ]);
} catch (err) {
  if (err instanceof BusyError) {
    console.error("Database busy after retries:", err.cause);
    // Retry later or fail gracefully
  } else if (err instanceof ConnectionError) {
    console.error("Broken connection:", err.message);
  } else {
    throw err; // Unexpected error — re-throw
  }
}
```

**Transaction errors are re-thrown directly** (v0.1.0+). The callback error is no longer wrapped in `TransactionError`. The transaction is rolled back, and the original error propagates to the caller.

---

## Limitations

### SQLite
- **SQLite single-writer** — `run()` is synchronous, matching `bun:sqlite` directly. On-disk throughput: **~40K writes/s** with `synchronous=NORMAL`. In-memory throughput exceeds **85M ops/s**.
- **Fixed-size statement cache** — Max 100 cached statements. Highly diverse workloads trigger evictions.
- **Single-process only** — Not designed for multi-process writes to the same SQLite file.

### Query Engine (MongoDB/Redis/PG/MySQL)
- **SQL → MongoDB coverage**: Full CRUD, WHERE (all operators), JOIN (INNER/LEFT/RIGHT/FULL/CROSS/NATURAL), GROUP BY, ORDER BY, LIMIT/OFFSET, CTE, UNION, subqueries, DDL (CREATE/DROP TABLE). Does NOT cover `$geoNear`, `$text`, `$facet`, `$graphLookup`.
- **MQL → SQL coverage**: All 28 filter operators, 9 accumulator types, update operators ($inc/$unset/$push/$pull), computed $project, complex $lookup. Does NOT cover `$unwind` (SQLite doesn't have UNNEST), `$first/$last SQL` window functions (not all dialects), nested sub-document updates.
- **`$regex` ↔ `LIKE` is bidirectional**: SQL LIKE wildcards (`%`/`_`) are converted to regex (`.*`/`.`) when translating to MQL, and regex patterns are converted back to LIKE wildcards (strip `^`/`$`, convert `.*`→`%`, `.`→`_`) when translating to SQL. Regex anchors (`^`, `$`), quantifiers (`*`, `+`), and character classes (`[abc]`, `\d`) beyond simple wildcards are best-effort.
- **`$elemMatch` MySQL is simple-only**: MySQL translation uses `JSON_SEARCH()` which supports simple value matching only. Complex conditions like `{ $elemMatch: { x: 1, y: { $gt: 5 } } }` require `JSON_TABLE()` which is not yet implemented. Use PostgreSQL or SQLite for complex `$elemMatch` queries.
- **Redis coverage**: Subset only — `HGETALL`, `HSET`, `DEL`, `ZRANGE`. Complex queries (GROUP BY, JOIN) not supported on Redis.
- **Drivers**: All 4 network drivers (MongoDB, Redis, PostgreSQL, MySQL) are production-ready via `@nds-stack/bunql/driver`. Each uses custom TCP + wire protocol, zero npm dependencies.

### General
- **Not an ORM** — No schema management, query building, or migrations. You write SQL/MQL.
- **Bun-only** — Not compatible with Node.js or Deno.

---

## Multi-Instance / Cross-Process

SQLite is an embedded, single-writer database. bunql does not coordinate across processes.

### Same Process, Multiple Instances

Creating multiple `BunQL` instances pointing to the same database file (same process, separate instances) is **not recommended**. Each instance has its own `StatementCache` — they do not share state. SQLite itself handles concurrent connections, but the caches operate independently.

**Instead:** Create a single `BunQL` instance and share it across your application:

```typescript
// app.ts — export once, import everywhere
export const db = new BunQL("./app.db");

// services/user.ts
import { db } from "../app";

// services/logs.ts
import { db } from "../app";
```

### Worker Threads / Cluster

Bun workers can share a `BunQL` instance via `workerData`:

```typescript
// main.ts
const db = new BunQL("./app.db");
const worker = new Worker("./worker.ts", { workerData: { db } });
```

### Multiple Processes (External Access)

If another process (e.g., a Node.js app, CLI tool, or separate Bun process) opens the same SQLite file, bunql cannot serialize those writes. The external writer may trigger `SQLITE_BUSY`:

```typescript
const db = new BunQL("./app.db", {
  retry: { maxRetries: 10, baseDelay: 100 },  // Higher tolerance for external contention
  busyTimeout: 10000,  // SQLite-level busy timeout
});
```

For multi-process scenarios, consider using a client-server database (PostgreSQL, MySQL) instead.

### Server-Side (BunQLServer)

The HTTP bridge (`bunql/server`) is a single-instance server:

```typescript
import { BunQL } from "@nds-stack/bunql";
import { BunQLServer } from "@nds-stack/bunql/server";

const db = new BunQL("./app.db");
const server = new BunQLServer(db, { port: 3000, auth: { apiKey: "my-api-key" } });
server.start();
// → HTTP endpoint: http://localhost:3000
//   - read/query routes: direct — no queue
//   - transaction/batch/exec routes: serialized through WriteQueue
```

Write operations via the `/run` endpoint are synchronous (direct to `bun:sqlite`). Transaction and batch operations via `/tx`, `/batch`, `/exec` endpoints are serialized through the same `WriteQueue`.

---

## Stability

- **v0.3.0-beta.7 (current)** — All 5 backends + 424 tests + CASE WHEN + Subquery WHERE/EXISTS + Window Functions + Known Limitations docs + JSDoc cleanup
- **v0.3.0 (stable)** — Statement format control, transaction modes, pragma helper, serialize, verbose mode
- **424 tests** — unit, integration, concurrency, stress, FTS5, parser, translators, BSON, RESP, PG wire, MySQL wire, transactions, MQL operators, CASE, subquery, windows
- **5000 sequential writes** — verified stable
- **Graceful shutdown** — drain queue → finalize statements → close DB
- **Memory safe** — LRU cache eviction, `yocto-queue` linked-list, no unbounded growth
- **Retry strategy** — exponential backoff with ±50% jitter (baseDelay 50ms)
- **Zero-dependency drivers** — MongoDB, Redis, PG, MySQL — all custom wire protocol via `Bun.connect()`
- **Hand-written parsers** — SQL parser (recursive descent), MQL parser (object traversal), all wire protocols
- **Observability** — built-in metrics counters, cache stats, WAL monitoring, slow query detection, verbose tracing
- **Audit score** — 100/100 (zero BLOCKING issues)
- **Bundle** — 112.9KB core, 5.2KB server, 134.7KB driver (MongoDB + Redis + PG + MySQL), 71.2KB query (SQL + MQL builder)

---

## License

MIT &mdash; see [LICENSE](LICENSE).

---

*Part of the [@nds-stack](https://github.com/nds-stack) collection of Bun-native tools.*
