# bunql

Lightweight SQLite wrapper for Bun with queued writes, serialized transactions, and SQLITE_BUSY handling.

## Features

- **Queued writes** — All write operations serialized through async FIFO queue
- **Serialized transactions** — `BEGIN IMMEDIATE` with SAVEPOINT support for nesting
- **SQLITE_BUSY retry** — Exponential backoff with jitter for transient lock conflicts
- **WAL mode default** — Concurrent reads during writes without blocking
- **Prepared statement cache** — LRU cache for repeated queries
- **Batch operations** — Multiple writes in a single transaction
- **Event hooks** — Lifecycle callbacks for monitoring and logging
- **Zero dependencies** — Only `bun:sqlite` (native Bun module)
- **TypeScript strict** — Full type safety with strict mode

## Installation

```bash
bun add bunql
```

## Quick Start

```typescript
import { BunQL } from "bunql";

const db = new BunQL("./app.db");

// Create table
await db.run(
  "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT)"
);

// Insert data
await db.run("INSERT INTO users (name) VALUES (?)", ["Alice"]);

// Query data
const users = db.query<{ id: number; name: string }>(
  "SELECT * FROM users WHERE name = ?",
  ["Alice"]
);
console.log(users.rows); // [{ id: 1, name: "Alice" }]

// Transaction
await db.transaction(async (tx) => {
  await tx.run("INSERT INTO users (name) VALUES (?)", ["Bob"]);
  await tx.run("INSERT INTO users (name) VALUES (?)", ["Charlie"]);
});

// Prepared statement
const stmt = db.prepare<{ id: number; name: string }, [string]>(
  "SELECT * FROM users WHERE name = ?"
);
const bob = stmt.get("Bob");

// Batch
await db.batch([
  { sql: "INSERT INTO users (name) VALUES (?)", params: ["Dave"] },
  { sql: "INSERT INTO users (name) VALUES (?)", params: ["Eve"] },
]);

// Cleanup
await db.close();
```

## API

### `new BunQL(path, options?)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `wal` | `boolean` | `true` | Enable WAL journal mode |
| `readonly` | `boolean` | `false` | Open database in read-only mode |
| `busyTimeout` | `number` | `5000` | SQLite busy timeout in ms |
| `retry` | `RetryConfig` | — | Retry policy for SQLITE_BUSY |
| `logger` | `Logger` | — | Logger for debug/warn/error |
| `hooks` | `BunQLHooks` | — | Lifecycle callbacks |
| `events` | `EventHandlers` | — | Event handlers |

### `RetryConfig`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxRetries` | `number` | `5` | Maximum retry attempts |
| `baseDelay` | `number` | `10` | Base delay in ms |
| `maxDelay` | `number` | `1000` | Maximum delay cap |
| `jitter` | `boolean` | `true` | Random jitter on delay |

### Methods

| Method | Description |
|--------|-------------|
| `query(sql, params?)` | Execute read query (parallel safe, not queued) |
| `run(sql, params?)` | Execute write query (serialized via queue) |
| `transaction(callback)` | Execute callback in serialized transaction |
| `prepare(sql)` | Create cached prepared statement |
| `batch(operations)` | Execute multiple writes in a transaction |
| `close()` | Graceful shutdown (drains queue, finalizes statements) |

## Architecture

```
User Code
    │
    ▼
┌─────────────────────────────────────┐
│  BunQL (Facade)                     │
│                                     │
│  .query() ──► StatementCache ──► DB │ ← Reads: parallel, cached
│  .run()   ──► WriteQueue ──► DB     │ ← Writes: serialized
│  .transaction() ──► TxManager ──► DB│ ← Transactions: serialized
└─────────────────────────────────────┘
```

## Benchmarks

Results from Bun v1.3.13 (1000 iterations each):

| Operation | Raw bun:sqlite | BunQL | Overhead |
|-----------|---------------|-------|----------|
| Read | 327K ops/s | 147K ops/s | -55% |
| Write | 800 ops/s | 790 ops/s | -1% |
| 50 concurrent writes | — | 842 ops/s | — |

Writes via BunQL have near-zero overhead thanks to efficient queue serialization. Reads have moderate overhead from cache lookups, still providing ~147K ops/s.

## License

MIT
