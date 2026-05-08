# bunql — TODO & Roadmap

**Current Version:** `0.1.0-alpha.4`

**Status:** Core features (M0-M5) complete. Observability & data safety features added.

---

## ✅ Completed in v0.1.0-alpha.4

- `metrics` getter — write/read/transaction/queue counters for production monitoring
- `cacheStats` getter — statement cache hit rate
- `walStatus()` — WAL file size, page info, checkpoint detection
- `checkpoint(mode)` — explicit WAL checkpoint control
- `backup(path)` — online backup via `VACUUM INTO` (safe, queue-aware)
- 102 tests (was 96)

## ✅ Completed in v0.1.0-alpha.1

- `raw` getter for direct `bun:sqlite` access (custom PRAGMA, VACUUM, etc.)
- `exec()` method for multi-statement SQL (schema file loading)
- PRAGMA constructor options: `synchronous`, `cacheSize`, `foreignKeys`
- `TransactionContext.batch()` for batch writes inside transactions
- Statement caching inside transactions for performance
- `BusyError` properly thrown on retry exhaustion (with `cause` chain)
- `onError` event handler fully wired
- `prepare().run()` now serialized through WriteQueue (no more SQLITE_BUSY)
- `prepare().finalize()` safely removes from cache
- `close()` sequence fixed: drain → finalize (not premature reject)
- `durationMs` measured correctly in `prepare().run()`
- `BatchOperation.params` typed as `SQLQueryBindings[]`

---

## Milestone 0 — Project Bootstrap

- [ ] Finalisasi `package.json` (name, version, exports, type, engines, scripts)
- [ ] Finalisasi `tsconfig.json` (sesuai Bun + strict)
- [ ] Buat folder structure: `src/`, `src/types/`, `src/errors/`, `test/`, `test/helpers/`, `bench/`, `examples/`
- [ ] Buat `.npmignore`
- [ ] Buat `CHANGELOG.md` dengan `[Unreleased]`
- [ ] Setup `src/errors/bunql-error.ts` — base error class
- [ ] Setup `src/types/options.ts` — konfigurasi type definitions
- [ ] Setup `src/types/result.ts` — result type definitions
- [ ] Setup `src/index.ts` — re-export skeleton

---

## Milestone 1 — WriteQueue & Core Query

- [ ] Implementasi `BunQL` constructor — open database, set WAL mode, validate path
- [ ] Implementasi `BunQL.query<T>()` — read-only query, parallel safe
- [ ] Implementasi `WriteQueue` class — FIFO async queue untuk serialize writes
- [ ] Implementasi `BunQL.run()` — write via WriteQueue
- [ ] Implementasi `BunQL.close()` — graceful shutdown, drain queue
- [ ] Error mapping: raw SQLite errors → custom `BunQLError` hierarchy
- [ ] Unit test: `WriteQueue` enqueue/process/drain
- [ ] Unit test: `BunQL.query()` basic read
- [ ] Unit test: `BunQL.run()` basic write
- [ ] Unit test: `BunQL.close()` drains queue before closing

---

## Milestone 2 — Transaction Support

- [ ] Implementasi `TransactionManager` — serialized transaction execution
- [ ] Implementasi `BunQL.transaction()` — begin/commit/rollback wrapper
- [ ] Transaction context (`tx`) — `.run()` dan `.query()` dalam transaction scope
- [ ] Automatic rollback on error dalam transaction callback
- [ ] Nested transaction support via SAVEPOINT
- [ ] Error: `TransactionError` untuk transaction-specific failures
- [ ] Unit test: transaction commit success
- [ ] Unit test: transaction rollback on error
- [ ] Unit test: transaction isolation (concurrent reads during write)
- [ ] Unit test: nested transaction / SAVEPOINT

---

## Milestone 3 — Retry & Resilience

- [ ] Implementasi `RetryPolicy` — exponential backoff dengan jitter
- [ ] Konfigurasi: `maxRetries`, `baseDelay`, `maxDelay`, `jitter`
- [ ] Integrasikan retry ke `WriteQueue` untuk `SQLITE_BUSY` handling
- [ ] Integrasikan retry ke `TransactionManager`
- [ ] Error: `BusyError` untuk `SQLITE_BUSY` setelah semua retry exhausted
- [ ] Timeout support: `busyTimeout` pragma untuk SQLite built-in busy timeout
- [ ] Unit test: retry on SQLITE_BUSY
- [ ] Unit test: retry exhaustion → BusyError
- [ ] Unit test: exponential backoff timing
- [ ] Unit test: jitter randomization

---

## Milestone 4 — Prepared Statements & Batch

- [ ] Implementasi `StatementCache` — LRU cache untuk prepared statements
- [ ] Implementasi `BunQL.prepare<T, P>()` — cached prepared statement
- [ ] Implementasi `BunQL.batch()` — batch write operations dalam satu queue slot
- [ ] Batch dengan transaction wrapper otomatis (optional)
- [ ] Statement finalization pada `close()`
- [ ] Unit test: prepared statement creation dan reuse
- [ ] Unit test: statement cache hit/miss
- [ ] Unit test: batch write correctness
- [ ] Unit test: batch atomicity

---

## Milestone 5 — Events & Hooks

- [ ] Implementasi event system: `onBusy`, `onRetry`, `onDrain`, `onError`
- [ ] Hook system: `beforeWrite`, `afterWrite`, `beforeTransaction`, `afterTransaction`
- [ ] Logging integration point (user-provided logger)
- [ ] Unit test: event emission
- [ ] Unit test: hook execution order

---

## Milestone 6 — Concurrency & Stress Testing

- [ ] Test: 100+ concurrent writes — all succeed, no SQLITE_BUSY leaks
- [ ] Test: concurrent reads during write — no starvation
- [ ] Test: concurrent transactions — serialized, consistent
- [ ] Test: queue drain under high load
- [ ] Test: retry behavior under sustained contention
- [ ] Test: graceful close under active operations
- [ ] Test: memory leak check under long-running scenario
- [ ] Test: edge cases — empty database, corrupt database, read-only filesystem

---

## Milestone 7 — Benchmarking

- [ ] Benchmark: simple read throughput vs raw `bun:sqlite`
- [ ] Benchmark: simple write throughput vs raw `bun:sqlite`
- [ ] Benchmark: concurrent write throughput (1, 10, 50, 100 concurrent)
- [ ] Benchmark: transaction throughput
- [ ] Benchmark: batch vs individual writes
- [ ] Benchmark: retry overhead (idle vs contended)
- [ ] Benchmark: prepared statement cache hit rate
- [ ] Dokumentasi hasil benchmark di `bench/RESULTS.md`
- [ ] Performance budget: overhead < 5% vs raw `bun:sqlite` untuk reads, < 10% untuk writes

---

## Milestone 8 — Documentation & Publish

- [ ] Tulis `README.md` — overview, installation, quick start, API reference
- [ ] Tulis `CHANGELOG.md` — version 0.1.0 entry
- [ ] Verifikasi semua exports di `src/index.ts`
- [ ] Verifikasi TypeScript types — no `any`, strict mode clean
- [ ] Verifikasi `package.json` exports map (ESM)
- [ ] Verifikasi `package.json` files field (hanya publish yang diperlukan)
- [ ] Verifikasi `.npmignore` — exclude test, bench, examples, docs
- [ ] Jalankan `bun test` — semua test hijau
- [ ] Jalankan `bun build` — build sukses tanpa error
- [ ] Cek bundle size — < 10KB minified
- [ ] Test install di fresh project: `bun add bunql`
- [ ] Test import: `import { BunQL } from "bunql"`
- [ ] Test CI-ready: `bun test` exit code 0
- [ ] Publish ke npm: `npm publish --access public`
- [ ] Tag release: `git tag v0.1.0` dan push

---

## Version Target

| Milestone | Target Versi |
|-----------|-------------|
| M0 — M4 | `0.1.0-alpha.x` |
| M5 | `0.1.0-beta.1` |
| M6 — M7 | `0.1.0-rc.1` |
| M8 | `0.1.0` (stable) |

---

## Catatan

- Setiap milestone harus memiliki **semua test hijau** sebelum lanjut ke milestone berikutnya
- Benchmark hanya dilakukan setelah fitur core selesai (M0-M4)
- Versi `0.1.0` adalah first stable release — fokus pada reliability, bukan feature count
- Setelah `0.1.0`, fitur baru melalui proposal di `PROJECT.md` sebelum implementasi