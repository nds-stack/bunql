# bunql

## Visi

Menjadi wrapper SQLite paling reliable dan ringan untuk Bun runtime — menyelesaikan masalah writer lock secara elegan tanpa menambah kompleksitas bagi developer.

---

## Masalah yang Ingin Diselesaikan

SQLite adalah database embedded yang cepat dan ringan, namun memiliki satu kelemahan kritis: **writer lock**. Saat satu koneksi menulis, seluruh database terkunci untuk penulisan lain. Ini menyebabkan:

1. **`SQLITE_BUSY` errors** — concurrent writes gagal dengan error "database is locked"
2. **Data loss risk** — retry naive tanpa strategy bisa menyebabkan write hilang
3. **Unpredictable behavior** — race condition pada concurrent transactions
4. **Poor DX** — developer harus manual handle retry, queuing, dan serialization

Di ecosystem Bun, `bun:sqlite` sudah tersedia sebagai native binding yang cepat, namun **tidak menyediakan mekanisme concurrency handling**. Developer harus sendiri mengelola writer lock, retry logic, dan transaction serialization.

**bunql** hadir untuk mengisi gap ini — menyediakan abstraction layer yang aman tanpa mengorbankan performa dan simplicity.

---

## Goals

- **Queued writes** — semua write operations di-serialize melalui write queue, menghilangkan SQLITE_BUSY
- **Serialized transactions** — transaction berjalan secara serial, menjamin consistency
- **Retry strategy** — exponential backoff dengan jitter untuk handle transient SQLITE_BUSY
- **Simple API** — zero-config, developer bisa mulai dalam < 5 menit
- **Minimal dependency** — hanya bergantung pada `bun:sqlite` (native Bun)
- **Production-ready** — error handling yang proper, logging, dan observability
- **Type-safe** — full TypeScript support dengan strict mode

---

## Non-Goals

- **ORM features** — tidak ada model, relation, atau Active Record pattern
- **Query builder** — gunakan raw SQL, bukan fluent API
- **Multi-database support** — hanya SQLite via `bun:sqlite`
- **Non-Bun runtime** — tidak mendukung Node.js, Deno, atau browser
- **Migration system** — bukan tanggung jawab wrapper
- **Connection pooling** — SQLite single-writer, pooling tidak diperlukan
- **Network/remote database** — hanya local file atau in-memory

---

## Arsitektur

```
bunql
├── BunQL (Facade)          ← Entry point utama, public API
│   ├── .query()            ← Read-only query (parallel safe, readerPool optional)
│   ├── .run()              ← Write query (via WriteQueue)
│   ├── .transaction()      ← Serialized transaction
│   ├── .prepare()          ← Prepared statement (cached)
│   ├── .batch()            ← Batch write operations
│   ├── .exec()             ← Multi-statement SQL (via WriteQueue)
│   ├── .raw                ← Getter: akses langsung Database bun:sqlite
│   ├── .fts                ← Getter: FTS5 helper (search, insert, delete, update, rebuild, etc)
│   ├── .metrics            ← Getter: real-time operation counters
│   ├── .cacheStats         ← Getter: statement cache hit rate
│   ├── .walStatus()        ← WAL file & checkpoint status
│   ├── .checkpoint()       ← Explicit WAL checkpoint
│   ├── .backup()           ← Online backup via VACUUM INTO
│   ├── .vacuum()           ← Incremental or full vacuum
│   └── .close()            ← Graceful shutdown
│
├── BunQLServer (opsional)  ← HTTP bridge, import dari @nds-stack/bunql/server
│
├── ReaderPool              ← Multi-connection parallel reads (opsional)
│   ├── next()              ← Round-robin reader connection
│   └── close()             ← Close all connections
│
├── FTS5Helper              ← Full-text search engine
│   ├── create()            ← Create FTS5 virtual table
│   ├── insert/update/delete ← CRUD
│   ├── search()            ← MATCH query with snippet/highlight
│   ├── rebuild/merge/optimize ← Index maintenance
│   └── drop()              ← Remove virtual table
│
├── WriteQueue              ← Serialisasi semua write operations
│   ├── enqueue()           ← Tambah operation ke queue
│   ├── process()           ← Process queue secara serial
│   └── drain()             ← Tunggu sampai queue kosong
│
├── TransactionManager      ← Serialized transaction execution
│   ├── begin()             ← Mulai transaction context
│   ├── commit()            ← Commit transaction
│   └── rollback()          ← Rollback on error
│
├── RetryPolicy             ← Retry strategy untuk SQLITE_BUSY
│   ├── maxRetries          ← Konfigurasi max retry attempts
│   ├── baseDelay           ← Base delay untuk exponential backoff
│   ├── maxDelay            ← Cap untuk delay maximum
│   └── jitter              ← Random jitter untuk avoid thundering herd
│
└── Errors                  ← Custom error hierarchy
    ├── BunQLError          ← Base error class
    ├── BusyError           ← SQLITE_BUSY specific
    ├── TransactionError    ← Transaction failure
    └── QueueError         ← WriteQueue failure
```

### Data Flow

```
User Code
    │
    ▼
┌──────────────────────────────────────────────┐
│  BunQL (Facade)                              │
│                                              │
│  .query()        ───► bun:sqlite (direct)   │ ← Reads: parallel, no queue
│  .run()          ───► WriteQueue ──► DB      │ ← Writes: serialized
│  .exec()         ───► WriteQueue ──► DB      │ ← Multi-stmt: serialized
│  .prepare()      ───► StatementCache ──► DB  │ ← Reads: cache, Writes: queue
│  .transaction()  ───► TxManager ──► DB       │ ← Transactions: serialized
│  .batch()        ───► WriteQueue ──► DB      │ ← Batch: serialized + atomic
│  .raw            ───► Database (direct)      │ ← Direct access (getter)
│  .metrics        ───► Internal counters      │ ← Real-time observability
│  .cacheStats     ───► StatementCache stats   │ ← Cache efficiency
│  .walStatus()    ───► PRAGMA queries         │ ← WAL health
│  .checkpoint()   ───► WriteQueue ──► DB      │ ← WAL checkpoint control
│  .backup()       ───► WriteQueue ──► DB      │ ← Online backup
└──────────────────────────────────────────────┘
```

### Key Design Decisions

1. **Single database connection** — SQLite adalah single-writer, multiple connections tidak memberikan benefit untuk writes
2. **WAL mode default** — Write-Ahead Logging mengizinkan concurrent reads saat write berlangsung
3. **Async queue** — Write operations di-serialize dalam async queue, reads tetap parallel
4. **Optimistic concurrency** — Default coba dulu, retry kalau BUSY, bukan pessimistic locking

---

## Filosofi Package

1. **Explicit over implicit** — Behavior harus jelas, tidak ada magic
2. **Bun-native** — Manfaatkan Bun API, jangan fight against runtime
3. **Zero-config default** — Harus work out of the box, konfigurasi opsional
4. **Fail fast** — Error harus muncul secepat mungkin, tidak di-silence
5. **Minimal surface** — API kecil tapi powerful, extendable via hooks/events
6. **Production-first** — Setiap feature harus bisa diandalkan di production

---

## Contoh Target API

### Inisialisasi

```typescript
import { BunQL } from "bunql";

const db = new BunQL("./app.db");
```

### Query (Read)

```typescript
const users = db.query<{ id: number; name: string }>(
  "SELECT * FROM users WHERE active = ?",
  [true],
);
```

### Run (Write)

```typescript
await db.run("INSERT INTO users (name) VALUES (?)", ["Alice"]);
```

### Transaction

```typescript
const result = await db.transaction(async (tx) => {
  await tx.run("INSERT INTO users (name) VALUES (?)", ["Alice"]);
  await tx.run("UPDATE counters SET total = total + 1");
  return { success: true };
});
```

### Batch

```typescript
await db.batch([
  { sql: "INSERT INTO users (name) VALUES (?)", params: ["Alice"] },
  { sql: "INSERT INTO users (name) VALUES (?)", params: ["Bob"] },
  { sql: "UPDATE counters SET total = total + 2" },
]);
```

### Exec (Multi-Statement SQL)

```typescript
await db.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE logs (id INTEGER PRIMARY KEY, message TEXT);
  INSERT INTO users VALUES (1, 'seed');
`);
```

### Raw Database Access

```typescript
import { BunQL } from "bunql";
import type { Database } from "bun:sqlite";

const db = new BunQL("./app.db");
const raw: Database = db.raw;
raw.run("PRAGMA cache_size=-8000");
raw.run("PRAGMA synchronous=FULL");
raw.exec("VACUUM");
```

### Reader Pool (Parallel Reads)

```typescript
import { BunQL } from "bunql";

// Pool of 3 read-only connections, round-robin
const db = new BunQL("./app.db", { readerPool: 3 });

// Reads otomatis terdistribusi ke pool connections
const users = db.query("SELECT * FROM users");
const posts = db.query("SELECT * FROM posts");
// Kedua query bisa jalan parallel di connection berbeda
await db.close();
```

### FTS5 Full-Text Search

```typescript
import { BunQL } from "bunql";

const db = new BunQL("./app.db");

// Setup FTS5 virtual table
await db.fts.create("articles", ["title", "body"]);

// Insert documents
await db.fts.insert("articles", { title: "Hello World", body: "SQLite FTS5 guide" });

// Search with ranking
const results = db.fts.search("articles", "sqlite", {
  limit: 10,
  snippet: true,
  highlight: true,
});
// → [{ rowid: 1, title: "...", body: "...", snippet: "...<b>SQLite</b>...", rank: -1.2 }]

// Index maintenance
await db.fts.optimize("articles");
await db.fts.drop("articles");
```

### Maintenance Mode

```typescript
import { BunQL } from "bunql";

const db = new BunQL("./app.db", {
  maintenance: {
    checkpoint: { enabled: true, pagesThreshold: 1000, mode: "TRUNCATE" },
    vacuum: { enabled: true, mode: "incremental", pagesPerStep: 100 },
    backup: { enabled: true, intervalMs: 86_400_000, path: "./backups/" },
    integrityCheck: { enabled: true, intervalMs: 604_800_000 },
  },
  slowQueryThreshold: 100,
  pragma: { autoVacuum: "INCREMENTAL" },
  events: {
    onSlowQuery: (sql, ms) => console.warn(`Slow query (${ms}ms):`, sql),
  },
});
```

### Vacuum

```typescript
// Full vacuum
await db.vacuum();

// Incremental (tidak block writes lama)
const result = await db.vacuum({ incremental: true, pagesPerStep: 100 });
console.log(`Reclaimed ${result.pagesReclaimed} pages in ${result.durationMs}ms`);
```

### Metrics

```typescript
const m = db.metrics;
console.log(m.writes.total);        // Total writes executed
console.log(m.writes.failed);       // Failed writes
console.log(m.writes.retried);      // Retry count
console.log(m.reads.total);         // Total reads
console.log(m.transactions.committed);
console.log(m.transactions.rolledBack);
console.log(m.queue.currentSize);   // Current queue depth
console.log(m.queue.peakSize);      // Peak queue depth
console.log(m.queue.totalEnqueued); // Total queued operations
```

### Cache Stats

```typescript
const s = db.cacheStats;
console.log(s.size);     // Number of cached statements
console.log(s.hits);     // Cache hits
console.log(s.misses);   // Cache misses
console.log(s.hitRate);  // Ratio (0-1)
```

### WAL Management

```typescript
// Check WAL status
const status = await db.walStatus();
console.log(status.walSizePages);
console.log(status.pageCount);
console.log(status.checkpointRequired);

// Manual checkpoint
await db.checkpoint("TRUNCATE");
await db.checkpoint("PASSIVE");
await db.checkpoint("FULL");
```

### Backup

```typescript
const result = await db.backup("./safety-copy.db");
console.log(`Backup completed in ${result.durationMs}ms`);
```

### Close

```typescript
await db.close();
```