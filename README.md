# @nds-stack/bunql

> Lightweight SQLite wrapper for Bun — queued writes, serialized transactions, SQLITE_BUSY handling.

[![npm version](https://img.shields.io/npm/v/%40nds-stack%2Fbunql?color=blue&logo=npm)](https://www.npmjs.com/package/@nds-stack/bunql)
[![Bun](https://img.shields.io/badge/Bun-%3E%3D1.0.0-black?logo=bun)](https://bun.sh)
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
- [Benchmarks](#benchmarks)
- [Limitations](#limitations)
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
import { BunQL, TransactionError } from "@nds-stack/bunql";

const db = new BunQL("./app.db");

try {
  await db.transaction(async (tx) => {
    await tx.run("UPDATE accounts SET balance = balance - 100 WHERE id = 1");
    await tx.run("UPDATE accounts SET balance = balance + 100 WHERE id = 2");
  });
} catch (error) {
  if (error instanceof TransactionError) {
    console.error("Transaction failed:", error.cause);
    // error.cause contains the original error
  }
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
| `logger` | `Logger` | — | Logger (`console`-compatible) |
| `hooks` | `BunQLHooks` | — | Lifecycle callbacks |
| `events` | `EventHandlers` | — | Event handlers |

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
| `raw` | `Database` | Getter — akses langsung ke instance `bun:sqlite`. |
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
4. Success → `COMMIT`. Failure → `ROLLBACK` (original error in `cause`)
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
| Error chain preserved | `error.cause` always contains the original error. |

---

## Compared to Raw bun:sqlite

| Aspect | `bun:sqlite` | `@nds-stack/bunql` |
|--------|-------------|-------------------|
| API surface | Low-level, direct | Same SQL, added convenience |
| Write concurrency | Manual retry needed | Automatic queue + retry |
| Transactions | Manual BEGIN/COMMIT | Scoped callbacks with auto-rollback |
| Error handling | Raw SQLite errors | Typed `BunQLError` hierarchy with `cause` |
| Reads | Direct | Cached (LRU, max 100) |
| Prepared stmts | Manual manage | Auto-cached, reused |
| Graceful shutdown | Manual | Queue drain + cache finalize |
| Bundle size | Built-in | +20.1KB (includes yocto-queue) |

bunql is not a replacement for `bun:sqlite` — it's a **safety layer** on top. You still write raw SQL. The wrapper handles what developers consistently get wrong: concurrency, error recovery, and resource cleanup.

---

## Benchmarks

Environment: Bun v1.3.13, Windows x64, 500 iterations per test.
Both benchmarks use identical PRAGMA settings: `WAL`, `synchronous=NORMAL`, `cache_size=-2000`, `foreign_keys=ON`.

### Synthetic Throughput

| Operation | Raw `bun:sqlite` | `@nds-stack/bunql` | Overhead |
|-----------|-----------------|--------------------|----------|
| Point read | 142K ops/s | 234K ops/s | **+64.7%** |
| Single write | 32.0K ops/s | 21.7K ops/s | -32.3% |
| 10 concurrent writes | — | 50.4K ops/s | — |
| 50 concurrent writes | — | 25.8K ops/s | — |

> Reads benefit from statement cache (LRU, max 100). Writes have ~32% overhead from queue serialization — the cost of guaranteed `SQLITE_BUSY`-free concurrency.

### Realistic Workloads

| Workload | Description | Throughput |
|----------|-------------|-----------|
| Mixed | Interleaved reads/writes/transactions | 29.0K ops/s |
| Batch | 25 writes per transaction (10 batches) | 211.5K ops/s |
| Cache pressure | 200 unique queries (triggers evictions) | 36.2K ops/s |

---

## Limitations

- **SQLite single-writer** — bunql queues writes, but peak throughput is bound by SQLite (~800-1000 writes/s on typical hardware).
- **Fixed-size statement cache** — Max 100 cached statements. Highly diverse workloads trigger evictions.
- **Single-process only** — Not designed for multi-process writes to the same SQLite file.
- **Not an ORM** — No schema management, query building, or migrations. You write SQL.

---

## Stability

- **96 tests** — unit, integration, concurrency, stress
- **5000 sequential writes** — verified stable
- **Graceful shutdown** — drain queue → finalize statements → close DB
- **Memory safe** — LRU cache eviction, `yocto-queue` linked-list, no unbounded growth
- **Retry strategy** — exponential backoff with ±50% jitter (baseDelay 50ms)

---

## License

MIT &mdash; see [LICENSE](LICENSE).

---

*Part of the [@nds-stack](https://github.com/nds-stack) collection of Bun-native tools.*
