# Changelog

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

## [Unreleased]