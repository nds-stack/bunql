# Changelog

## [Unreleased]

### Added
- Initial project bootstrap with folder structure, ESLint, TypeScript strict mode
- Base error hierarchy (BunQLError, BusyError, TransactionError, QueueError, ConnectionError)
- Type definitions for options, config, and query results
- Core BunQL facade class with query(), run(), close()
- WriteQueue with async FIFO serialization writes (microtask-deferred processing)
- TransactionManager with SAVEPOINT support for nested transactions
- RetryPolicy with exponential backoff and jitter for SQLITE_BUSY handling
- StatementCache for prepared statement caching with LRU eviction
- Batch write operations with automatic transaction wrapping
- Event system (onBusy, onRetry, onDrain, onError)
- Lifecycle hooks (beforeWrite, afterWrite, beforeTransaction, afterTransaction)
- Logger integration point for observability
- WAL mode enabled by default for concurrent read performance
- Configurable busy timeout and retry strategy
- Graceful shutdown with queue drain
- Comprehensive test suite: 65 tests covering all modules
  - WriteQueue: ordering, error handling, drain, clearPending, concurrent enqueues
  - BunQL: query, run, close, options, concurrent reads
  - Transaction: commit, rollback, nested, isolation, serialization
  - Retry: exponential backoff, jitter, busy detection, callbacks
  - StatementCache: caching, eviction, clear
  - Batch: execution, rollback on failure
  - Events: hooks lifecycle, drain, logging
  - Concurrency: 100 concurrent writes, mixed read/write, stress testing
- Benchmarks vs raw bun:sqlite
  - Read throughput: ~147K ops/s (55% overhead vs raw)
  - Write throughput: ~790 ops/s (1% overhead vs raw)
  - Concurrent writes scale linearly with queue serialization
- Production-ready documentation (PROJECT.md, RULES.md, TODO.md)