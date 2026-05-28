# Changelog

## [Unreleased]

## [0.1.2] - 2026-05-28

### Documentation
- Add dedicated "Error Handling" section with error hierarchy and catch patterns
- Add "Customization" section covering logger, hooks, events, cache tuning
- Add "Multi-Instance / Cross-Process" section with worker/process guidance
- Fix PROJECT.md FTS5 examples (sync since v0.1.0)
- Fix RULES.md folder diagram (add fts5.ts, reader-pool.ts, server/)
- Sync all docs version to 0.1.2

## [0.1.1] - 2026-05-18

### Fixed
- Maintenance timer async rejection now caught (prevents unhandled promise rejection)
- LRU eviction in statement cache: O(n) scan replaced with O(1) Map insertion-order eviction

### Changed
- Clean script: removed redundant `--bun` flag

## [0.1.0] - 2026-05-17

### Changed (Breaking)
- **Transaction error behavior:** Callback error in `transaction()` is no longer wrapped in `TransactionError`. The original error is now re-thrown directly after rollback. Callers no longer lose the original error type.
- **FTS5 methods are now synchronous:** `create()`, `drop()`, `insert()`, `delete()`, `update()`, `rebuild()`, `merge()`, `optimize()`, `integrityCheck()` no longer return `Promise` — they don't perform async I/O.
- **Reader pool requires WAL mode:** `readerPool > 0` with `wal: false` now throws `ConnectionError`.

### Fixed
- `exec()` now tracks `metrics.writes.total` and `metrics.writes.failed` (was underreporting).
- `batch()` now tracks `metrics.writes.total` and `metrics.writes.failed`.
- `cacheStats` now includes reader pool connection caches.
- Backup path now rejects `..` traversal.
- FTS5 column names sanitized against embedded double-quote injection.
- Maintenance timer guarded against race with `close()`.
- Reader pool close errors are now logged instead of silently ignored.
- `integrityCheck()` now throws on `no such table` instead of returning `false`.
- `#getPageSize()` extracted to private getter (DRY).
- Batch execution loop extracted to shared function (DRY).
- `readerPoolSize` backward-compat path removed (use `readerPool`).
- `yocto-queue` pinned to exact version `0.1.0`.

## [0.1.0-alpha.7] - 2026-05-15

### Fixed
- Deadlock in maintenance scheduler: `#startMaintenance` no longer calls `walStatus()`/`checkpoint()` through WriteQueue while already inside a queue callback. Added `#checkpointDirect()` and `#walStatusDirect()` for internal use.
- Maintenance interval used `pagesThreshold` (page count) as timer interval (ms). Added `intervalMs` config field for checkpoint and vacuum, default 60000ms.
- Backup path sanitization: `VACUUM INTO` path now validated with `#validateBackupPath()` before execution.
- Silent `.catch(() => {})` in maintenance scheduler replaced with proper error logging.

### Changed
- `readerPool` and `readerPoolSize` options consolidated to `readerPool`. `readerPoolSize` still accepted for backward compatibility.
- Nested transaction rollback now triggers `afterTransaction` hook (false).
- Added `@module` JSDoc headers to all source files.

### Removed
- `readerPoolSize` from `BunQLOptions` type definition (deprecated).

## [0.1.0-alpha.5] - 2026-05-08

### Added
- `readerPool` option — multi-connection read pool for parallel reads (default: 0 = off)
- `fts` getter + `FTS5Helper` — full FTS5 API: create, insert, delete, update, search, snippet, highlight, rebuild, merge, optimize, drop, rank
- `vacuum()` — incremental or full vacuum with page count tracking
- `backup(path)` — online backup via `VACUUM INTO` through WriteQueue
- `MaintenanceConfig` — auto-scheduler: periodic checkpoint, vacuum, backup, integrity check via `setInterval`
- `slowQueryThreshold` — callback when query/run exceeds threshold in ms
- `pragma.autoVacuum` option (`INCREMENTAL` / `FULL` / `NONE`)
- `BunQLServer` — optional HTTP bridge via `bunql/server` subpath import

### Changed
- 111 tests (was 102)
- Build now produces two entry points: `./dist/index.js` and `./dist/server/index.js`

## [0.1.0-alpha.4] - 2026-05-08

### Added
- `metrics` getter — real-time counters (writes, reads, transactions, queue stats)
- `cacheStats` getter — statement cache hit/miss ratio
- `walStatus()` — WAL file size, page info, checkpoint requirement check
- `checkpoint(mode)` — explicit WAL checkpoint (PASSIVE/FULL/RESTART/TRUNCATE)
- `backup(path)` — safe online backup via `VACUUM INTO` through WriteQueue

### Changed
- `RetryPolicy.onBusy` now always tracks retry count internally (even without user event handler)
- 102 tests (was 96)

## [0.1.0-alpha.3] - 2026-05-08

### Documentation
- Update README with new API (`exec`, `raw`, `tx.batch()`, PRAGMA options)
- Update benchmarks with latest performance numbers
- Fix `Statement.run()` return type to `Promise<RunResult>`
- Update stability count from 84 to 96 tests

## [0.1.0-alpha.2] - 2026-05-08

### Performance
- Replace `Array.shift()` with `yocto-queue` (linked-list) for O(1) dequeue in WriteQueue
- Reuse `StatementCache` for `run()` and `batch()` — no more per-call `prepare()`/`finalize()`

### Changed
- `RetryPolicy` default `baseDelay` increased from 10ms to 50ms for better SQLITE_BUSY tolerance

### Dependencies
- Added `yocto-queue@^0.1.0` as runtime dependency

## [0.1.0-alpha.1] - 2026-05-08

### Added
- `raw` getter: direct access to underlying `bun:sqlite` Database instance
- `exec()` method: run multi-statement SQL (e.g. schema files) via WriteQueue
- PRAGMA constructor options: `synchronous`, `cacheSize`, `foreignKeys`
- `TransactionContext.batch()`: batch writes inside transaction scope
- Statement cache inside transactions (avoids per-call prepare/finalize overhead)
- `onError` event handler now properly wired and called on operation failures
- `BusyError` is now thrown when retry policy is exhausted (preserves original error as `cause`)
- `StatementCache.remove()`: allows safe finalization of individual cached statements

### Fixed
- `prepare().run()` now goes through WriteQueue, preventing SQLITE_BUSY from concurrent writes
- `prepare().finalize()` properly removes statement from cache, preventing use-after-free crashes
- `close()` now drains queue before finalizing (no premature rejection of pending writes)
- `durationMs` in `prepare().run()` now correctly measured instead of hardcoded to 0
- `BatchOperation.params` type changed from `unknown[]` to `SQLQueryBindings[]` for type safety

### Changed
- `Statement.run()` now returns `Promise<RunResult>` instead of `RunResult` (write serialization)
- PRAGMA defaults: `synchronous=NORMAL`, `cache_size=-2000`, `foreign_keys=ON`

## [0.1.0-alpha.0] - 2026-05-07

### Added
- Initial public release of bunql
- Bun runtime-focused SQLite wrapper with safe concurrent write handling
- Async FIFO WriteQueue for serialized writes
- TransactionManager with nested SAVEPOINT support
- RetryPolicy with exponential backoff and jitter for SQLITE_BUSY handling
- Prepared statement cache with LRU eviction
- Batch write operations with automatic transaction wrapping
- Lifecycle hooks and event callbacks
- Graceful shutdown with queue draining and statement cleanup
- WAL mode enabled by default for concurrent read performance
- TypeScript strict-mode support
- ESM build output with generated declaration files
- GitHub Actions CI workflow for lint, typecheck, build, and tests

### Improved
- Production-ready package exports and dist build structure
- SQLITE_BUSY detection using SQLite errno handling
- Error propagation with preserved original error causes
- Queue shutdown stability and drain handling
- Statement cache cleanup safety
- Documentation covering limitations, architecture, and usage guidance

### Testing
- 84 automated tests covering:
  - Write queue behavior
  - Concurrent writes
  - Transactions and nested SAVEPOINT flows
  - Retry handling
  - Graceful shutdown
  - Statement cache behavior
  - Batch operations
  - Stress and concurrency scenarios
- Added realistic workload stress tests:
  - 5000 sequential writes
  - Concurrent write batches
  - Mixed read/write/transaction workloads
  - Repeated open/close cycles
  - Cache pressure scenarios

### Performance
- Stable concurrent write throughput through internal write serialization
- Minimal write overhead compared to raw bun:sqlite
- Prepared statement caching for cache-friendly read workloads

### Documentation
- Added architecture overview and implementation philosophy
- Added SQLite limitations and tradeoff explanations
- Added concurrent write examples
- Added transaction usage examples
- Added guidance for when to use bunql vs PostgreSQL/MySQL
