# @nds-stack/bunql

> Ergonomic SQLite wrapper for Bun — transaction safety, statement caching, observability. Zero overhead on writes.

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

**`bun:sqlite` is already fast.** Its `stmt.run()` and `stmt.all()` are synchronous C bindings — zero overhead. bunql doesn't try to beat raw speed.

**bunql adds safety and ergonomics** where `bun:sqlite` leaves you on your own:

| Raw `bun:sqlite` | bunql |
|---|---|
| Manual `BEGIN/COMMIT/ROLLBACK` | `db.transaction(cb)` — auto-rollback, SAVEPOINT nesting |
| Manual statement lifecycle | LRU cache (100), auto-finalize on close |
| Manual cleanup on shutdown | `db.close()` — drain pending ops, finalize cache |
| No built-in observability | `db.metrics`, `db.cacheStats`, slow query logging |
| No reader pool for WAL | `readerPool: N` — round-robin parallel reads |
| PRAGMA setup manual | Auto-configure WAL, sync=NORMAL, FK=ON, cache |
| FTS5 API manual | `db.fts.search()`, insert, optimize, rebuild |

```typescript
const db = new BunQL("./app.db");

// Writes are synchronous — just like raw bun:sqlite
db.run("INSERT INTO users (name) VALUES (?)", ["Alice"]);

// Read — cached prepared statement
const users = db.query<{ id: number; name: string }>("SELECT * FROM users");

// Transaction — async with auto-rollback
await db.transaction(async (tx) => {
  tx.run("UPDATE accounts SET balance = balance - 100 WHERE id = 1");
  tx.run("UPDATE accounts SET balance = balance + 100 WHERE id = 2");
});
```

---

## Design Goals

- **Minimal abstraction** — A thin, transparent layer over `bun:sqlite`. No magic. No ORM.
- **Zero overhead writes** — `run()` is synchronous, direct to `bun:sqlite`. No queue, no retry, no Promise.
- **Production-first** — Transaction safety (auto-rollback, SAVEPOINT). Error chains preserved (`error.cause`).
- **Bun-native** — Uses `bun:sqlite`, `Bun.sleep()`, `Bun.file()`. No Node.js polyfills.
- **Observability built-in** — Real-time metrics, statement cache stats, slow query logging.

---

## When to Use

- You need SQLite with a clean API for writes, transactions, and FTS5.
- You want serialized transactions without manual retry logic.
- You want a lightweight alternative to heavier database wrappers.
- You need embedded storage for a Bun service, CLI tool, or single-process server.

## When Not to Use

| Scenario | Recommendation |
|----------|---------------|
| **High write throughput with true concurrency** | SQLite is single-writer. Use PostgreSQL/MySQL if you need parallel write scaling. |
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
| `metricsEnabled` | `boolean` | `false` | Enable performance counters and timing. Set `true` to track writes/reads/durationMs. |
| `extractColumns` | `boolean` | `false` | Extract column names via `Object.keys(rows[0])`. Set `true` if you need column metadata. |
| `queryTimeoutMs` | `number` | `0` | Interrupt queries exceeding this duration. `0` = disabled. |
| `busyTimeout` | `number` | `5000` | SQLite busy timeout (ms) |
| `synchronous` | `'OFF' \| 'NORMAL' \| 'FULL' \| 'EXTRA'` | `'NORMAL'` | Synchronous mode (NORMAL recommended for WAL) |
| `cacheSize` | `number` | `-2000` | Page cache size (negative = KB, -2000 = 2MB) |
| `foreignKeys` | `boolean` | `true` | Enforce FOREIGN KEY constraints |
| `retry` | `RetryConfig` | — | Retry policy for SQLITE_BUSY (transaction/batch/exec/backup/vacuum only — `run()` bypasses retry) |
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
| `prepare(sql)` | `Statement<T, P>` | Cached prepared statement. `.run()` is sync. |
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
  run(...params: P): RunResult;
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

### `run()` is synchronous

```diff
- import { BunQL } from "@nds-stack/bunql";
-
- // v0.1.x: run() was async (wrapped in Promise)
- await db.run("INSERT INTO users (name) VALUES (?)", ["Alice"]);
- const result = await db.run("INSERT INTO users (name) VALUES (?)", ["Bob"]);
+ // v0.2.0: run() is synchronous — direct to bun:sqlite
+ db.run("INSERT INTO users (name) VALUES (?)", ["Alice"]);
+ const result = db.run("INSERT INTO users (name) VALUES (?)", ["Bob"]);
+ // result: { changes: 1, lastInsertRowid: 2, durationMs: 0.0 }
```

### `beforeWrite` / `afterWrite` hooks no longer called by `run()`

```diff
  const db = new BunQL("./app.db", {
-   hooks: {
-     beforeWrite: (sql) => console.log("Writing:", sql),
-     afterWrite: (sql, params, ms) => console.log(`Done in ${ms}ms`),
-   },
  });
```

These hooks are no longer called by `run()` since v0.2.0 (sync path has no hook point). They are still called for operations inside `batch()`. The `beforeTransaction` / `afterTransaction` hooks remain for transaction monitoring.

### WriteQueue no longer used for `run()`

The `WriteQueue` is now only used for operations that need serialization: `transaction()`, `batch()`, `exec()`, `backup()`, `vacuum()`, `checkpoint()`. Individual writes (`run()`) bypass the queue entirely.

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
 │  db.run()    db.query()    db.transaction()    raw       │
 │  (sync)      (sync)       (async)             (getter)   │
 └──────┬──────────┬──────────────┬───────────────┬─────────┘
        │          │              │               │
        ▼          ▼              ▼               ▼
 ┌──────────┐  ┌──────────┐  ┌──────────────┐  ┌──────────┐
 │ Statement│  │ Statement│  │ WriteQueue   │  │   raw    │
 │  Cache   │  │  Cache   │  │  (tx/batch/  │  │ (getter) │
 │ (LRU/100)│  │  (+pool) │  │   exec)      │  │  direct  │
 │          │  │          │  │  +SAVEPOINT  │  │  access  │
 └────┬─────┘  └────┬─────┘  └──────┬───────┘  └────┬─────┘
      │             │               │               │
      └─────────────┴───────────────┴───────────────┘
                     │
                     ▼
            ┌─────────────────┐
            │  bun:sqlite     │
            │  (WAL mode)     │
            │  + PRAGMA opts  │
            └─────────────────┘
```

### Write Flow

`run()` is **synchronous** — direct to `bun:sqlite` via statement cache. No WriteQueue, no Promise, no retry:

```
db.run(sql, params)
  → StatementCache.get(sql)
  → stmt.run(params)
  → return { changes, lastInsertRowid }
```

### Read Flow

`query()` also bypasses WriteQueue — synchronous read via statement cache. When `readerPool > 0`, reads route through **ReaderPool** (round-robin across read-only connections) for parallel-safe concurrent reads.

### Transaction Flow

`transaction()`, `batch()`, `exec()` go through **WriteQueue** — the only operations that need serialization:

1. Enter WriteQueue (serialized execution order)
2. `BEGIN IMMEDIATE` — prevents overlapping transactions
3. Callback receives `TransactionContext` with `run()` / `query()` / `batch()` / `prepare()`
4. Success → `COMMIT`. Failure → `ROLLBACK` (original error re-thrown directly, no wrapper)
5. Nested transactions use SQLite **SAVEPOINT** for isolation

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Single DB connection | SQLite is single-writer. Multiple connections don't help writes. |
| WAL mode default | Enables concurrent reads during writes. |
| `run()` is sync | `bun:sqlite` is sync — wrapping with Promise adds overhead for no benefit. |
| WriteQueue only for tx/batch | Transactions need serialization (BEGIN→COMMIT). Writes don't. |
| Reads bypass queue | Reads execute directly — never blocked by writes. |
| `raw` getter exposed | Users need escape hatch for PRAGMA kustom, VACUUM, dll. |
| Original error preserved | Transaction errors re-thrown directly, no wrapper. |

---

## Compared to Raw bun:sqlite

| Aspect | `bun:sqlite` | `@nds-stack/bunql` |
|--------|-------------|-------------------|
| API surface | Low-level, direct | Same SQL, added convenience |
| Write path | `stmt.run()` (sync C binding) | `db.run()` (sync, cached statement) |
| Transactions | Manual BEGIN/COMMIT | Scoped callbacks with auto-rollback + SAVEPOINT |
| Error handling | Raw SQLite errors | Typed `BunQLError` hierarchy; original errors preserved |
| Reads | Direct | Cached (LRU, max 100) |
| Prepared stmts | Manual manage | Auto-cached, reused |
| Graceful shutdown | Manual | Drain pending ops + cache finalize |
| Bundle size | Built-in | +34.4KB core / +5.1KB server |

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

---

## Benchmarks

**Test machine:** Intel i7-7500U @ 2.90GHz, 8GB RAM, Samsung NVMe SSD 238GB, Windows 10 x64<br>
**Methodology:** 5000 iterations, 1000 warmup (discarded), 5 runs, reporting median (min–max).<br>
**Settings:** All targets use identical PRAGMA — `WAL`, `synchronous=NORMAL`, `cache_size=-2000`, `foreign_keys=ON`.

**7 competitors across 3 runtimes:** Bun 1.3.14 (native), Node.js 22.12.0 (CJS), Deno 2.7.14 (FFI).

### Synthetic Throughput

| Operation | `bun:sqlite` raw | Manual retry | `better-sqlite3` 12 | `sqlite3` 6.0 | `node:sqlite` | Deno SQLite | `sql.js` WASM | **BunQL** |
|-----------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Point read | 268K | 321K | 256K | 23.9K | 246K | 124K | 37.3K | **259K** |
| Single write | 38.4K | 45.7K | 35.5K | 14.5K | 37.6K | 34.8K | 13.0K | **41.9K** |
| 10 concurrent | 56.1K | 71.0K | 38.3K | — | 31.4K | 48.4K | — | **51.8K** |
| 50 concurrent | 28.8K | 29.1K | 31.1K | — | 34.2K | 35.0K | — | **39.9K** |

> `sqlite3@6.0.1` is callback-based — serialized async queue. Read/Write measured via callback completion. `sql.js` is WASM single-threaded. Both excluded from concurrent tests.
>
> `better-sqlite3` and `node:sqlite` are **synchronous blocking** APIs — writes execute sequentially on the main thread via `setImmediate` scheduling. No true concurrency occurs (no overlap, no SQLITE_BUSY). Concurrent numbers reflect event loop overhead, not parallel throughput. Compare with `bun:sqlite` (raw) and Manual retry for fair async concurrency benchmarks.
>
> Concurrent writes use manual retry loop (max 5 attempts, exponential backoff). BunQL `run()` is synchronous — no retry needed. For queue-based operations (`transaction`, `batch`, `exec`), retry is handled automatically.
>
> **Hardware matters.** Official better-sqlite3 benchmark reports 314K read / 62.6K write on macOS (SSD). Our 294K / 40.8K on Windows NVMe is consistent — macOS I/O stack has lower `fsync` latency for SQLite commits.

### Realistic Workloads (BunQL only)

| Workload | Description | Throughput |
|----------|-------------|-----------|
| Mixed | 167r + 167w + 166tx | 22.4K ops/s |
| Batch | 500 writes in single batch call | 82.9K ops/s |
| Cache pressure | 200 unique queries (triggers LRU evictions) | 23.2K ops/s |

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

- **SQLite single-writer** — `run()` is synchronous, matching `bun:sqlite` directly. Peak throughput depends on PRAGMA settings. With `synchronous=NORMAL`, `cache_size=-2000`, and statement cache, typical hardware achieves **35-42K writes/s**. Using `synchronous=FULL` (SQLite default) reduces this significantly.
- **Fixed-size statement cache** — Max 100 cached statements. Highly diverse workloads trigger evictions.
- **Single-process only** — Not designed for multi-process writes to the same SQLite file.
- **Not an ORM** — No schema management, query building, or migrations. You write SQL.

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
const server = new BunQLServer(db, { port: 3000, secret: "my-api-key" });
server.start();
// → HTTP endpoint: http://localhost:3000
//   - read/query routes: direct — no queue
//   - transaction/batch/exec routes: serialized through WriteQueue
```

Write operations via the `/run` endpoint are synchronous (direct to `bun:sqlite`). Transaction and batch operations via `/tx`, `/batch`, `/exec` endpoints are serialized through the same `WriteQueue`.

---

## Stability

- **v0.2.0 (stable)** — BREAKING: sync `run()`, honest architecture — no fake concurrency safety
- **109 tests** — unit, integration, concurrency, stress, FTS5, reader pool
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
