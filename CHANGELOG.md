# Changelog

## [Unreleased]

### Added
- **Integration tests** — 4 new files covering SQLite/PG/MySQL/MongoDB CRUD via integration (test/integration/)
- **Redis benchmark** — bench/vs-bun-sql.ts RedisDriver section (skips gracefully if Redis unavailable)
- **Benchmark SQLite** — separate `:memory:` databases for fair bun:sqlite vs BunQL comparison
- **SQL → MongoDB: JOIN → $lookup pipeline** — SELECT with JOIN now generates aggregate $lookup
- **SQL → MongoDB: GROUP BY → aggregate pipeline** — SELECT GROUP BY now generates $group stage
- **SQL → MongoDB: DISTINCT → $group** — SELECT DISTINCT generates $group with _id for distinct values
- **SQL → MongoDB: aggregate functions** — COUNT/SUM/AVG/MIN/MAX in SELECT → $group accumulators
- **SQL → MongoDB: HAVING** — HAVING clause → $match after $group
- **SQL → MongoDB: updateMany/deleteMany** — SQL UPDATE/DELETE now uses MongoDB updateMany/deleteMany
- **SQL dialect support** — astToSQL() accepts dialect param: "postgresql" ($1 placeholders), "mysql" (backtick quoting)
- **Subqueries parser** — `FROM (SELECT ...) AS sub` now parses to TableRef.subquery
- **Arithmetic expressions** — `a + b`, `price * qty` parsed as binary ColumnExpr in SELECT
- **MQL parser: missing methods** — findOne, updateMany, deleteMany, replaceOne, findOneAndUpdate, findOneAndDelete
- **MQL parser: $nor** — `{ $nor: [...] }` operator → AND of NOT conditions
- **MQL parser: $mod/$all/$size/$type** — additional filter operators (approximate SQL translation)
- **MQL parser: $regex + $options** — `{ field: { $regex: "pat", $options: "i" } }` support
- **Feature Support Matrix** — comprehensive README table covering all 5 backends
- **.gitignore** — test/tmp/ and bench/tmp/ directories
- **PG auth extraction** — auth logic moved to src/driver/pg/auth.ts (reduces pg/connection.ts by 15%)

### Changed
- **bunql.ts refactor** — split from 984 lines into 9 files (<200 lines each): bunql-core.ts, bunql-state.ts, bunql-init.ts, bunql-query.ts, bunql-tx.ts, bunql-maintenance.ts, bunql-close.ts, statement-wrapper.ts
- **to-sql.ts aggregate translation** — rewrite to fix $skip/$project silent ignore, adds $lookup→JOIN support
- **to-mongodb.ts translateSelect** — rewritten to auto-detect when aggregate pipeline is needed
- **Tests: 345 (was 308)** — +37 integration tests
- **Bundle: 82.8KB core / 115.5KB driver / 5.2KB server** — slight increase from refactor
- **BunQL class no longer accepts mongodb:///redis:///postgres:///mysql:// URLs** — throws helpful error directing to driver subpath imports
- **README cleanup** — removed obsolete "Migrating from v0.1.0-alpha.x" section, fixed incorrect code examples (MongoDB/PG placeholder syntax, Dual API, constructor examples)

### Fixed
- **PG encodeBind** — invalid result format count (be16(1) without format code → be16(0))
- **MySQL parsePrepareOK** — format mismatch with MySQL 8.0 OK header + 4B/2B fields
- **MySQL encodeStmtExecute** — null params skipped TYPE info, now sends type for all params
- **PG command tag regex** — `match[2]` → `match[1]` after regex change for INSERT/UPDATE/DELETE counts
- **PG ErrorResponse** — empty message when extended query protocol rejected (encodeBind fixed)
- **RetryPolicy.execute()** — now wired to batch/exec/transaction/checkpoint/backup/vacuum (was dead code)
- **RelationsQuery.all()/get()** — removed dead `result` variable that caused double SQL execution
- **sql-builder.ts/mql-builder.ts** — converted .then() chains to async/await
- **Dead imports** — removed MySQLConnectionPool/PGConnectionPool/ConnectionPool from connection files
- **MySQL escapeValue** — added \n, \r, \x1a escape sequences
- **HTTP handler** — added typeof body.sql !== "string" type guard
- **Aggregate translation SQL header rebuild bug** — fixed overwrite of WHERE clause when $group after $match

## [v0.8.0] — 2025-05-20

### Added (v0.8.0 — Transactions + Parameterized Queries)
- **Custom MySQL wire protocol** — zero npm dependencies, big-endian packet framing:
  - **Packet format** — 3-byte LE length + 1-byte sequence ID + payload
  - **Handshake parsing** — server greeting: protocol version, server version, connection ID, auth-plugin-data, capabilities
  - **mysql_native_password auth** — SHA1-based challenge-response via pure JS SHA1
  - **COM_QUERY** — send SQL string, receive result set (column definitions + text rows + OK/ERR)
  - **ResultSet parsing** — length-encoded integers, column definitions, row values, multi-packet assembly
  - **OK/ERR packet** — affected rows, last insert ID, error code + message + SQL state
- **TCP connection + pool** — `Bun.connect()` with handshake + auth exchange
- **MySQLDriver class** — `query(sql)` / `run(sql)` via SQL→MySQL wire protocol
- **`@nds-stack/bunql/driver` exports** — `MySQLDriver`, `MySQLConnectionPool`, `MySQLError`
- **bunql.ts auto-detect** — `mysql://` and `mariadb://` URLs throw helpful error
- **Driver tests** — 12 tests: packet framing, len-encoded int, assemble, handshake parse, URL parsing

### Added (v0.6.0 — PostgreSQL Driver)
- **Custom PostgreSQL wire protocol (v3.0)** — zero npm dependencies, big-endian network byte order:
  - **StartupMessage** — protocol version 3.0, user/database params
  - **Auth exchange** — trust (no password), clear text, MD5 (`md5(md5(password+user)+salt)`)
  - **Pure JS MD5** — RFC 1321 implementation, zero deps
  - **SimpleQuery** — send SQL, receive RowDescription + DataRow + CommandComplete + ReadyForQuery
  - **ErrorResponse parsing** — severity, SQLSTATE code, message
- **TCP connection + pool** — `Bun.connect()` with auth handshake + deadline timeout
- **PGDriver class** — `query(sql)` / `run(sql)` via SQL→PG wire protocol
- **`@nds-stack/bunql/driver` exports** — `PGDriver`, `PGConnectionPool`, `PGError`
- **bunql.ts auto-detect** — `postgres://` and `postgresql://` URLs throw helpful error
- **SQL param interpolation** — `?` → escaped inline values (PG simple query protocol)
- **Driver tests** — 15 tests: wire protocol encode/decode, URL parsing, error connection

### Added (v0.4.2 — Redis Driver)
- **Custom Redis driver** — zero npm dependencies, built via `Bun.connect()`:
  - **RESP encoder/decoder** — Simple String, Error, Integer, Bulk String ($-1 null), Array (batch/nested)
  - **TCP connection** — `Bun.connect()` with `#tryResolvePending` + orphaned promise rejection guard
  - **AUTH support** — `redis://:password@host` — authenticates on connect
  - **SELECT support** — `redis://host/1` — selects database index on connect
  - **Connection pool** — non-recursive acquire with deadline timeout, stale cleanup
- **RedisDriver class** — `query(sql)` / `run(sql)` via SQL→AST→Redis pipeline
- **Pipeline support** — multi-key HGETALL via sequential `#sendCommand`
- **`@nds-stack/bunql/driver` exports** — `RedisDriver`, `RedisConnectionPool`, `RESPValue`, `encodeCommand`, `decodeSimple`
- **bunql.ts auto-detect** — `redis://` URLs throw helpful error directing to RedisDriver
- **Driver tests** — 25 new tests: RESP round-trip, encode/decode, partial reads, URL parsing, connection error

### Added (v0.4.1 — MongoDB Driver)
- **Custom MongoDB driver** — zero npm dependencies, built via `Bun.connect()`:
  - **BSON encoder** — JavaScript types → BSON bytes: string, int32, int64, double, boolean, null, document, array, ObjectId (12-byte), Date, Binary, RegExp, Timestamp
  - **BSON decoder** — BSON bytes → JavaScript types: full round-trip verified (18 tests)
  - **OP_MSG wire protocol** — buildCommand/parseResponse for MongoDB 3.6+ (flagBits, sections, checksum)
  - **TCP connection pool** — `Bun.connect()` with `#readBytes`/`#tryResolvePending` pattern (no partial read data loss)
  - **SCRAM-SHA-256 authentication** — RFC 5802 via Web Crypto API (SHA-256, HMAC, base64)
  - **ConnectionPool** — max pool size, non-recursive acquire with deadline timeout, stale connection cleanup
- **MongoDriver class** — `query(sql)` / `run(sql)` via SQL→AST→MongoDB pipeline
- **DriverAdapter interface** — unified contract: `query()`, `run()`, `close()`
- **`@nds-stack/bunql/driver` subpath** — separate entry point for MongoDB driver (45.6KB)
- **bunql.ts auto-detect** — `mongodb://` URLs now throw helpful error directing to MongoDriver
- **Driver tests** — 32 new tests: BSON round-trip, wire protocol parsing, MongoDriver URL parsing

### Added (v0.4.0 — Universal AST + Parsers)
- **Universal AST** — 29 node types + 10 constructors: SelectNode, InsertNode, UpdateNode, DeleteNode, AggregateNode, RawNode
- **Condition types** — eq, neq, gt, lt, gte, lte, and, or, not, like, notLike, in, notIn, between, isNull, isNotNull
- **Expression types** — column, alias, wildcard, literal, function, binary
- **Aggregate stages** — match, group, sort, limit, skip, project, lookup, unwind
- **SQL lexer** — 15 token types, keyword detection, comment skipping (102 lines)
- **SQL parser** — hand-written recursive descent: SELECT/INSERT/UPDATE/DELETE/JOIN/GROUP BY/HAVING/ORDER BY/LIMIT/OFFSET/DISTINCT/WHERE (AND/OR/NOT/LIKE/IN/BETWEEN/IS NULL) — 369 lines
- **MQL parser** — MongoDB object → AST: find/aggregate/insertOne/Many/updateOne/deleteOne, $gt/$lt/$in/$regex/$and/$or/$exists, aggregate stages — 173 lines
- **SQL translator** — AST → SQLite SQL + params: all conditions, JOIN, GROUP BY, aggregation (182 lines)
- **MongoDB translator** — AST → MongoDB find/insertOne/aggregate commands (183 lines)
- **Redis translator** — AST → Redis RESP commands: HGETALL/HSET/DEL/ZRANGE/SCAN (132 lines)
- **ParseError / DriverError** — extend BunQLError hierarchy
- **Parser + translator tests** — 44 new tests covering lexer, SQL parsing, MQL parsing, all 3 translators, SQL↔MongoDB round-trip

### Changed
- Bundle size: 80.9KB core, 5.1KB server, 101KB driver (+18.5KB for MySQL)
- Tests: 294 (was 282)
- Files: 4 new MySQL driver files (+873 LOC)
- `@nds-stack/bunql/driver` now exports MySQLDriver alongside MongoDriver/RedisDriver/PGDriver
- README: MySQL status updated to ✅ Production, MySQL Quick Start added
- TODO.md: Phase 6 milestone added, MySQL driver section

### Fixed (v0.4.2)
- **Redis:** `#tryResolvePending` catch block silently swallowed errors — orphaned connection Promise hangs forever. Fixed with proper error rejection + buffer cleanup
- **Redis:** `resp.ts` bulk-string decoder read offset bug (skipped `+2` for trailing `\r\n`)
- **Redis:** Redundant `export type { };` removed

### Fixed (v0.4.1)
- **Critical:** MongoDB TCP buffer corruption — `#onData` resolved with entire buffer instead of exact `n` bytes. Fixed with `#tryResolvePending()` + `#pendingSize` tracker
- **Critical:** Connection pool `acquire()` recursive — stack overflow under sustained load. Fixed with `while+deadline` loop
- BSON decoder: `readDocument` endOffset calculation (startOffset ++ totalLength, not this.offset ++ totalLength)
- Stale connections no longer silently discarded — proper `conn.close()` before pool pop
- `messageLength >= 16` validation added to prevent negative `#readBytes` calls
- `auth-scram.ts`: redundant `as unknown as string` cast removed

## [0.3.0] - 2026-05-28

### Added
- **Statement format control** — full better-sqlite3 parity on prepared statements:
  - `.raw(toggle?)` — return rows as arrays (`values()` internally). Mutually exclusive with `.pluck()`.
  - `.pluck(toggle?)` — return first column value only. Mutually exclusive with `.raw()`.
  - `.columns()` — column metadata (`ColumnInfo[]` with `name`, `column`, `table`, `database`, `type`).
  - `.bind(...params)` — permanent parameter binding. Overridden by call-site params.
  - `.iterate(...params)` — lazy row-by-row iterator (delegates to `bun:sqlite` native `.iterate()`).
  - `.values(...params)` — returns raw `unknown[][]` (delegates to `bun:sqlite` native `.values()`).
  - `.safeIntegers(toggle?)` — per-statement `BigInt` passthrough.
  - `.as(Class)` — map rows to class instances (prototype assignment, no constructor call).
  - `.source` — read-only SQL string property.
  - `.reader` — read-only boolean (true for SELECT/WITH/PRAGMA).
- **`db.pragma(source, options?)`** — convenience PRAGMA query method. `{ simple: true }` returns scalar (first column of first row). Auto-prefixes `PRAGMA` keyword.
- **Transaction modes** — `transaction(callback, mode)` where `mode` is `"deferred" | "immediate" | "exclusive"`. Default via `transactionMode` config option.
- **`db.serialize()`** — serialize entire database to `Uint8Array` (delegates to `bun:sqlite` native).
- **`BunQL.deserialize(contents, options?)`** — create instance from serialized buffer.
- **Database properties** — `db.name`, `db.memory`, `db.readonly`, `db.inTransaction` getters.
- **`safeIntegers` option** — passthrough to `bun:sqlite` for `BigInt` support on `INTEGER` columns.
- **`verbose` option** — `true` logs every SQL via logger, or custom `(sql: string) => void` callback.
- **`ColumnInfo` type** — exported alongside `Statement<T, P>`.

### Changed
- `Statement<T, P>` interface expanded from 4 methods to 15 methods + 2 readonly properties.
- `TransactionContext` now uses simpler inline statement type (avoids full `Statement` interface overhead in transactions).
- `#createContext` extracted from `TransactionManager` to `src/transaction-context.ts` (cleaner SRP).
- `TransactionManager` exposes `depth` getter (used by `db.inTransaction`).

### Fixed
- `bind()` parameter precedence: call-site params now correctly override permanently bound params.
- `iterate()` with `raw()` mode now uses `.values()` internally instead of `.iterate()` (ensures array output).
- `get()` with `raw()` mode: fixed `Object is possibly 'undefined'` on first row access.
- README: ServerOptions example corrected (`secret` → `auth.apiKey`).
- README: `.npmignore` now includes `context7.json` exclusion.
- `.gitignore`: removed dangling `# Environment.env` comment.
- `http-handler.ts`: removed unnecessary `await` on sync `tx.run()`.

### Internal
- Bundle size: 42.4KB core (+8KB for new Statement features), 5.1KB server (unchanged).
- Tests: 138 (was 109).
- Modules: 16 bundled (was 15) — new `transaction-context.ts` module.

## [0.2.0] - 2026-05-28

### Changed (BREAKING)
- **`run()` is now synchronous** — returns `RunResult`, not `Promise<RunResult>`. No WriteQueue, no retry, no hooks in write path. `await db.run()` → `db.run()`.
- **`Statement.run()` is now synchronous** — same as above. `await stmt.run()` → `stmt.run()`.
- **`TransactionContext.run()` / `.batch()` are now synchronous**
- **`querySync()` moved to direct Statement Cache path** — no reader pool, no timeout guard. Renamed internally; public `querySync()` still available as fast-path.
- **`beforeWrite` / `afterWrite` hooks no longer called by `run()`** — still functional inside `batch()` operations
- **Removed `runSync()`** — merged into `run()` (now sync)
- **`onBusy` / `onDrain` only fire for queue-based operations** — not from individual writes
- **`metrics.writes.failed` no longer incremented for sync writes** — sync writes throw directly
- **Repositioned as ergonomic wrapper** — not a "concurrent write safety" layer

### Internal
- WriteQueue retained for `transaction()`, `batch()`, `exec()`, `backup()`, `vacuum()`, `checkpoint()` — operations that genuinely need serialization

## [0.1.4] - 2026-05-28

### Added
- `runSync()` / `querySync()` — synchronous fast path bypassing queue, retry, and hooks for max throughput
- `metricsEnabled` option (default `true`) — disable `performance.now()` and counters to reduce overhead
- `queryTimeoutMs` option (default `0` = disabled) — interrupts long-running queries via `db.interrupt()`

### Fixed
- Timer leak in `query()` — `clearTimeout` now in `try/finally` block, preventing spurious `SQLITE_INTERRUPT`

## [0.1.3] - 2026-05-28

## [0.1.3] - 2026-05-28

### Fixed
- Transaction: added `#processing` guard — prevents nested transaction race when concurrent calls overlap
- Transaction: `began` flag prevents `ROLLBACK` error when `BEGIN IMMEDIATE` fails
- StatementCache: removed dead `lastUsed` field (Map insertion-order LRU is O(1) already)
- Close: `clearPending()` rejects queued operations on shutdown, preventing stale promise leaks
- Backup: improved `#validateBackupPath()` — empty path, length limit (512), backslash reject, character whitelist

### Changed
- WriteQueue: `Promise.withResolvers()` replaces `new Promise()` closure — reduces allocations per enqueue

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
