# @nds-stack/bunql

> Lightweight SQLite wrapper for Bun — queued writes, serialized transactions, SQLITE_BUSY handling.

[![npm version](https://img.shields.io/npm/v/%40nds-stack%2Fbunql?color=blue&logo=npm)](https://www.npmjs.com/package/@nds-stack/bunql)
[![Bun](https://img.shields.io/badge/Bun-%3E%3D1.3.0-black?logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue?logo=typescript)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

---

## Table of Contents

- [Why bunql](#why-bunql)
- [Design Goals](#design-goals)
- [When to Use](#when-to-use)
- [When Not to Use](#when-not-to-use)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Examples](#examples)
  - [Exec (Multi-Statement SQL)](#exec-multi-statement-sql)
  - [Batch Inside Transaction](#batch-inside-transaction)
  - [Raw Database Access](#raw-database-access)
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

## Why bunql

**Problem:** SQLite allows only one writer at a time. Concurrent writes produce `SQLITE_BUSY` errors. Developers must manually implement retry logic, queue writes, and serialize transactions — error-prone boilerplate that every SQLite project reinvents.

**Solution:** bunql wraps `bun:sqlite` with a `WriteQueue` that serializes all write operations. Reads remain parallel and lock-free (WAL mode). Transactions are serialized with automatic rollback. The result: safe concurrency with zero application-level retry logic.

```typescript
const db = new BunQL("./app.db");

// 100 concurrent writes — safe by default, no SQLITE_BUSY
const writes = Array.from({ length: 100 }, (_, i) =>
  db.run("INSERT INTO logs (message) VALUES (?)", [`log-${i}`])
);
await Promise.all(writes);
```

---

## Design Goals

- **Minimal abstraction** — A thin, transparent layer over `bun:sqlite`. No magic. No ORM.
- **Zero-config concurrency** — Writes are queued, reads are parallel. Out of the box.
- **Production-first** — Error chains preserved (`error.cause`). Retry with backoff. Graceful shutdown.
- **Bun-native** — Uses `bun:sqlite`, `Bun.sleep()`, `queueMicrotask`. No Node.js polyfills.
- **Single-file mental model** — One `BunQL` instance, one database connection. Predictable behavior.

---

## When to Use

- You need SQLite with concurrent writes from a Bun application.
- You want serialized transactions without manual retry logic.
- You want a lightweight alternative to heavier database wrappers.
- You need embedded storage for a Bun service, CLI tool, or single-process server.

## When Not to Use

| Scenario | Recommendation |
|----------|---------------|
| **High write throughput (>1000/s)** | Use PostgreSQL or MySQL. SQLite is single-writer. |
| **Multi-process access** | Use a client-server database, or coordinate via external locking. |
| **Distributed systems** | SQLite is embedded, not networked. Use a network database. |
| **ORM features needed** | Consider [Drizzle](https://orm.drizzle.team) or [Kysely](https://kysely.dev) with the `bun:sqlite` driver. |
| **Node.js / Deno runtime** | bunql is Bun-only. Use `better-sqlite3` for Node.js. |

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
await db.run(
  "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT)"
);

// Insert
await db.run("INSERT INTO users (name) VALUES (?)", ["Alice"]);

// Query (synchronous, uses statement cache)
const users = db.query<{ id: number; name: string }>(
  "SELECT * FROM users WHERE name = ?",
  ["Alice"]
);
// → { rows: [{ id: 1, name: "Alice" }], columns: ["id", "name"], durationMs: 0.12 }

// Transaction (atomatically rolls back on error)
await db.transaction(async (tx) => {
  await tx.run("INSERT INTO users (name) VALUES (?)", ["Bob"]);
  await tx.run("INSERT INTO users (name) VALUES (?)", ["Charlie"]);
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

// Raw access — langsung ke bun:sqlite untuk PRAGMA kustom / VACUUM
db.raw.run("PRAGMA cache_size=-8000");
db.raw.run("VACUUM");

// Graceful shutdown
await db.close();
```

---

## Examples

### Concurrent Writes

```typescript
import { BunQL } from "@nds-stack/bunql";

const db = new BunQL("./app.db");

const writes = Array.from({ length: 100 }, (_, i) =>
  db.run("INSERT INTO logs (message) VALUES (?)", [`event-${i}`])
);
await Promise.all(writes);
// All 100 writes succeed, serialized by the queue.
```

### Transaction with Error Recovery

```typescript
import { BunQL } from "@nds-stack/bunql";

const db = new BunQL("./app.db");

try {
  await db.transaction(async (tx) => {
    await tx.run("UPDATE accounts SET balance = balance - 100 WHERE id = 1");
    await tx.run("UPDATE accounts SET balance = balance + 100 WHERE id = 2");
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
  events: {
    onBusy: (attempt, delayMs) => {
      console.log(`Busy, retrying in ${delayMs}ms (attempt ${attempt + 1})`);
    },
    onDrain: () => console.log("Write queue drained"),
    onError: (err) => console.error("Operation failed:", err),
  },
  hooks: {
    beforeWrite: (sql) => console.log("Writing:", sql),
    afterWrite: (sql, _params, ms) => console.log(`  took ${ms.toFixed(1)}ms`),
  },
});
```

### Exec (Multi-Statement SQL)

Muat file skema `.sql` yang berisi banyak perintah sekaligus:

```typescript
import { BunQL } from "@nds-stack/bunql";
import { readFileSync } from "fs";

const db = new BunQL("./app.db");

// Load schema file — semua perintah dijalankan serial via WriteQueue
const schema = readFileSync("./schema.sql", "utf-8");
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

Akses langsung ke instance `Database` dari `bun:sqlite` untuk PRAGMA atau operasi yang tidak di-cover API:

```typescript
import { BunQL } from "@nds-stack/bunql";
import type { Database } from "bun:sqlite";

const db = new BunQL("./app.db");

// Dapatkan instance Database langsung
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

// Reads otomatis terdistribusi — parallel safe
const users = db.query("SELECT * FROM users");
const posts = db.query("SELECT * FROM posts");

await db.close();
```

### FTS5 Full-Text Search

Full-text search via built-in SQLite FTS5 (tanpa dependensi tambahan):

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

---

## API

### Constructor

```typescript
new BunQL(path: string, options?: BunQLOptions)
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `wal` | `boolean` | `true` | Enable WAL journal mode |
| `readonly` | `boolean` | `false` | Open in read-only mode |
| `busyTimeout` | `number` | `5000` | SQLite busy timeout (ms) |
| `synchronous` | `'OFF' \| 'NORMAL' \| 'FULL' \| 'EXTRA'` | `'NORMAL'` | Synchronous mode (NORMAL recommended for WAL) |
| `cacheSize` | `number` | `-2000` | Page cache size (negative = KB, -2000 = 2MB) |
| `foreignKeys` | `boolean` | `true` | Enforce FOREIGN KEY constraints |
| `retry` | `RetryConfig` | — | Retry policy for SQLITE_BUSY |
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
| `run(sql, params?)` | `Promise<RunResult>` | Write query. Serialized via queue, with retry. |
| `transaction(callback)` | `Promise<T>` | Serialized transaction. Auto-rollback on error. |
| `prepare(sql)` | `Statement<T, P>` | Cached prepared statement. |
| `batch(operations)` | `Promise<RunResult[]>` | Atomic multi-write transaction. |
| `exec(sql)` | `Promise<void>` | Multi-statement SQL (schema files, migrations). Serialized via queue. |
| `walStatus()` | `Promise<WalStatus>` | WAL file size, page info, checkpoint requirement. |
| `checkpoint(mode)` | `Promise<CheckpointResult>` | Explicit WAL checkpoint (PASSIVE \| FULL \| RESTART \| TRUNCATE). |
| `backup(path)` | `Promise<BackupResult>` | Online backup via `VACUUM INTO`. Safe, queue-aware. |
| `raw` | `Database` | Getter — akses langsung ke instance `bun:sqlite`. |
| `fts` | `FTS5Helper` | Getter — FTS5 search helper (create, search, insert, delete, update, rebuild, merge, optimize, drop). |
| `metrics` | `BunQLMetrics` | Getter — real-time operation counters (writes, reads, txs, queue). |
| `cacheStats` | `CacheStats` | Getter — statement cache hit/miss/size/rate. |
| `vacuum(opts?)` | `Promise<VacuumResult>` | Full or incremental vacuum. Returns reclaimed pages count. |
| `close()` | `Promise<void>` | Graceful shutdown. Drains queue, finalizes statements, closes DB. |

### Result Types

```typescript
interface QueryResult<T> {
  rows: T[];          // Result rows
  columns: string[];  // Column names
  durationMs: number; // Query execution time (ms)
}

interface RunResult {
  changes: number;              // Rows modified
  lastInsertRowid: number | bigint | null;  // Last inserted row ID
  durationMs: number;           // Execution time (ms)
}

interface Statement<T, P extends unknown[]> {
  all(...params: P): T[];
  get(...params: P): T | undefined;
  run(...params: P): Promise<RunResult>;
  finalize(): void;
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

---

## Migrating from v0.1.0-alpha.x

### Transaction errors no longer wrapped

```diff
- import { BunQL, TransactionError } from "@nds-stack/bunql";
+ import { BunQL } from "@nds-stack/bunql";

  try {
    await db.transaction(async (tx) => { ... });
  } catch (error) {
-   if (error instanceof TransactionError) { ... }
+   // Original error is re-thrown directly
+   console.error(error);
  }
```

### FTS5 methods are synchronous

```diff
- await db.fts.create("articles", ["title", "body"]);
- await db.fts.insert("articles", { title: "...", body: "..." });
+ db.fts.create("articles", ["title", "body"]);
+ db.fts.insert("articles", { title: "...", body: "..." });
```

### Reader pool requires WAL mode

```typescript
const db = new BunQL("./app.db", {
  wal: true,  // required when readerPool > 0
  readerPool: 3,
});
```

---

## Architecture

```
 ┌──────────────────────────────────────────────────────────┐
 │                      User Code                           │
 │  db.query()  db.run()  db.exec()  db.transaction()  raw  │
 └──────┬──────────┬──────────┬───────────────┬─────────────┘
        │          │          │               │
        ▼          ▼          ▼               ▼
 ┌──────────┐  ┌────────────┐  ┌──────────────┐  ┌──────────┐
 │ Statement │  │ WriteQueue │  │ Transaction  │  │   raw    │
 │  Cache   │  │  (FIFO)   │  │   Manager    │  │ (getter) │
 │ (LRU/100)│  │ (O(1)     │  │  +SAVEPOINT  │  │  direct  │
 │          │  │  deque)   │  │              │  │  access  │
 └────┬─────┘  └─────┬──────┘  └──────┬───────┘  └────┬─────┘
      │              │                │               │
      └──────────────┴────────────────┴───────────────┘
                     │
                     ▼
            ┌─────────────────┐
            │  bun:sqlite     │
            │  (WAL mode)     │
            │  + PRAGMA opts  │
            └─────────────────┘
```

### Write Flow

1. `run()` enqueues operation into **WriteQueue** (FIFO)
2. Queue processes one operation at a time (microtask-deferred)
3. Each write passes through **RetryPolicy** (exponential backoff for SQLITE_BUSY)
4. Retries exhausted → `BusyError` with original error as `cause`

### Transaction Flow

1. `transaction()` enters WriteQueue (serialized with writes)
2. `BEGIN IMMEDIATE` — prevents concurrent writers
3. Callback receives `TransactionContext` with `run()` / `query()` / `batch()` / `prepare()`
4. Success → `COMMIT`. Failure → `ROLLBACK` (original error re-thrown directly, no wrapper)
5. Nested transactions use SQLite **SAVEPOINT** for isolation

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Single DB connection | SQLite is single-writer. Multiple connections don't help writes. |
| WAL mode default | Enables concurrent reads during writes. |
| Reads bypass queue | Reads execute directly — never blocked by writes. |
| `raw` getter exposed | Users need escape hatch for PRAGMA kustom, VACUUM, dll. |
| Linked-list queue | `yocto-queue` untuk O(1) dequeue, bukan `Array.shift()` O(n). |
| Microtask-deferred queue | All synchronous enqueues complete before processing starts. |
| Original error preserved | Transaction errors re-thrown directly, no wrapper. |

---

## Compared to Raw bun:sqlite

| Aspect | `bun:sqlite` | `@nds-stack/bunql` |
|--------|-------------|-------------------|
| API surface | Low-level, direct | Same SQL, added convenience |
| Write concurrency | Manual retry needed | Automatic queue + retry |
| Transactions | Manual BEGIN/COMMIT | Scoped callbacks with auto-rollback |
| Error handling | Raw SQLite errors | Typed `BunQLError` hierarchy; original errors preserved |
| Reads | Direct | Cached (LRU, max 100) |
| Prepared stmts | Manual manage | Auto-cached, reused |
| Graceful shutdown | Manual | Queue drain + cache finalize |
| Bundle size | Built-in | +33.2KB core / +5.0KB server |

bunql is not a replacement for `bun:sqlite` — it's a **safety layer** on top. You still write raw SQL. The wrapper handles what developers consistently get wrong: concurrency, error recovery, and resource cleanup.

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

Monitor write operations without modifying business logic:

```typescript
const db = new BunQL("./app.db", {
  hooks: {
    beforeWrite: (sql) => trace.start("db_write", { sql }),
    afterWrite: (sql, _params, ms) => trace.end("db_write", { duration: ms }),
    beforeTransaction: () => console.log("TX starting"),
    afterTransaction: (success) => console.log(`TX ${success ? "committed" : "rolled back"}`),
  },
});
```

### Events

React to runtime conditions:

```typescript
const db = new BunQL("./app.db", {
  retry: { maxRetries: 5, baseDelay: 50 },
  slowQueryThreshold: 100,
  events: {
    onBusy: (attempt, delayMs) => metrics.increment("db_busy"),
    onDrain: () => console.log("Write queue empty"),
    onError: (err) => sentry.captureException(err),
    onSlowQuery: (sql, ms) => console.warn(`Slow query (${ms}ms):`, sql),
  },
});
```

### Statement Cache Tuning

The LRU cache holds up to 100 prepared statements. No config knob — the limit is deliberate to prevent unbounded growth. Highly diverse query patterns may trigger evictions; if you consistently see low hit rates in `cacheStats`, consider caching frequently-used queries at the application level.

---

## Benchmarks

**Test machine:** Intel i7-7500U @ 2.90GHz, 8GB RAM, Samsung NVMe SSD 238GB, Windows 10 x64<br>
**Methodology:** 5000 iterations, 1000 warmup (discarded), 5 runs, reporting median (min–max).<br>
**Settings:** All targets use identical PRAGMA — `WAL`, `synchronous=NORMAL`, `cache_size=-2000`, `foreign_keys=ON`.

**7 competitors across 3 runtimes:** Bun 1.3.14 (native), Node.js 22.12.0 (CJS), Deno 2.7.14 (FFI).

### Synthetic Throughput

| Operation | `bun:sqlite` raw | Manual retry | `better-sqlite3` 12.10 | `sqlite3` 6.0.1 | `node:sqlite` | Deno SQLite | `sql.js` WASM | **BunQL** |
|-----------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Point read | 381K | 392K | 294K | 23.9K | 239K | 137K | 36.7K | 291K |
| Single write | 40.0K | 37.3K | 40.8K | 14.9K | 37.4K | 34.5K | 12.9K | 34.6K |
| 10 concurrent | 45.1K | 70.8K | 43.1K | — | 32.4K | 65.7K | — | 36.0K |
| 50 concurrent | 38.7K | 35.9K | 24.4K | — | 25.4K | 31.0K | — | 32.5K |

> `sqlite3@6.0.1` is callback-based — serialized async queue. Read/Write measured via callback completion. `sql.js` is WASM single-threaded. Both excluded from concurrent tests.
>
> Concurrent writes use manual retry loop (max 5 attempts, exponential backoff). BunQL eliminates manual retry — writes are serialized, reads are parallel.
>
> **Hardware matters.** Official better-sqlite3 benchmark reports 314K read / 62.6K write on macOS (SSD). Our 294K / 40.8K on Windows NVMe is consistent — macOS I/O stack has lower `fsync` latency for SQLite commits.

### Realistic Workloads

| Workload | Description | Throughput |
|----------|-------------|-----------|
| Mixed | 167r + 167w + 166tx | 32.6K ops/s |
| Batch | 500 writes in 2.3ms | 217K ops/s |
| Cache pressure | 200 unique queries (triggers evictions) | 32.9K ops/s |

---

## Error Handling

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
  await db.run("INSERT INTO logs (msg) VALUES (?)", ["hello"]);
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

- **SQLite single-writer** — bunql queues writes, but peak throughput depends on PRAGMA settings. With `synchronous=NORMAL`, `cache_size=-2000`, and statement cache, typical hardware achieves **18-30K writes/s**. Using `synchronous=FULL` (SQLite default) reduces this significantly.
- **Fixed-size statement cache** — Max 100 cached statements. Highly diverse workloads trigger evictions.
- **Single-process only** — Not designed for multi-process writes to the same SQLite file.
- **Not an ORM** — No schema management, query building, or migrations. You write SQL.

---

## Multi-Instance / Cross-Process

SQLite is an embedded, single-writer database. bunql does not coordinate across processes.

### Same Process, Multiple Instances

Creating multiple `BunQL` instances pointing to the same database file (same process, separate instances) is **not recommended**. Each instance has its own `WriteQueue` and `StatementCache` — they do not share state. SQLite itself handles concurrent connections, but the wrapper's queues operate independently, defeating the purpose of serialized writes.

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
const server = new BunQLServer(db, { port: 3000, secret: "my-api-key" });
server.start();
// → HTTP endpoint: http://localhost:3000 — serialized through one BunQL instance
```

Each HTTP request enters the same `WriteQueue`, ensuring serialized writes across all API consumers.

---

## Stability

- **v0.1.2 (stable)** — documentation improvements
- **111 tests** — unit, integration, concurrency, stress, FTS5, reader pool
- **5000 sequential writes** — verified stable
- **Graceful shutdown** — drain queue → finalize statements → close DB
- **Memory safe** — LRU cache eviction, `yocto-queue` linked-list, no unbounded growth
- **Retry strategy** — exponential backoff with ±50% jitter (baseDelay 50ms)
- **Observability** — built-in metrics counters, cache stats, WAL monitoring

---

## License

MIT &mdash; see [LICENSE](LICENSE).

---

*Part of the [@nds-stack](https://github.com/nds-stack) collection of Bun-native tools.*
