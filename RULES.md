# bunql — Rules & Conventions

## 1. Standar Coding

- Gunakan **TypeScript strict mode** (`"strict": true`) tanpa exception
- Gunakan **ESM** (`import`/`export`) — tidak ada `require()` atau `module.exports`
- Tidak boleh menggunakan `any` — gunakan `unknown` jika type tidak diketahui
- Tidak boleh menambah comment di code kecuali diminta explicitly
- Gunakan `const` secara default, `let` hanya jika reassignment diperlukan, tidak boleh `var`
- Gunakan template literals daripada string concatenation
- Gunakan destructuring untuk multiple returns dan parameter objects

## 2. Aturan Async/Await

- Semua database operations **wajib async** — tidak ada synchronous DB calls yang exposed ke user
- Gunakan `async`/`await` — tidak boleh `.then()`/`.catch()` chain untuk flow control
- **Dilarang `Promise.all()` untuk write operations** — writes harus serialized
- `Promise.all()` hanya boleh untuk **read operations** yang independen
- Selalu handle promise rejection — tidak boleh floating promises
- Gunakan `Promise.withResolvers()` jika perlu manual resolve/reject

## 3. Aturan Error Handling

- Semua custom errors extend `BunQLError` (base class)
- Error hierarchy:

  ```
  BunQLError (base)
  ├── BusyError         — SQLITE_BUSY / SQLITE_BUSY_SNAPSHOT
  ├── TransactionError  — Gagal dalam transaction scope
  ├── QueueError        — WriteQueue failure
  └── ConnectionError   — Database connection failure
  ```

- **Dilarang swallow errors** — selalu propagate atau rethrow dengan context
- Saat rethrow, gunakan `cause` option: `new BunQLError("msg", { cause: originalError })`
- Tidak boleh empty `catch` block
- Tidak boleh `catch` lalu `return undefined` secara implicit
- Semua error harus memiliki pesan yang meaningful dan actionable
- Gunakan `result` pattern (`{ ok, value, error }`) hanya untuk expected failures, bukan exceptional cases

## 4. Aturan Header File

Setiap source file dimulai dengan JSDoc module header:

```typescript
/**
 * @module module-name
 * @description One-line description of module purpose.
 */
```

- Module name menggunakan kebab-case, sesuai nama file
- Description singkat, satu baris, menjelaskan purpose bukan implementation

## 5. Naming Convention

| Tipe | Convention | Contoh |
|------|-----------|--------|
| File name | `kebab-case.ts` | `write-queue.ts`, `retry-policy.ts` |
| Class | `PascalCase` | `WriteQueue`, `RetryPolicy`, `BunQL` |
| Interface | `PascalCase` (tanpa `I` prefix) | `BunQLOptions`, `RetryConfig` |
| Type alias | `PascalCase` | `QueryResult`, `SQLException` |
| Function | `camelCase` | `enqueue()`, `processQueue()` |
| Variable | `camelCase` | `maxRetries`, `baseDelay` |
| Constant | `SCREAMING_SNAKE_CASE` | `DEFAULT_BUSY_TIMEOUT`, `MAX_RETRY_DELAY` |
| Private field | `camelCase` dengan `private` keyword | `private queue` |
| Event name | `camelCase` | `onBusy`, `onRetry`, `onDrain` |
| Generic type | `PascalCase` single letter atau descriptive | `T`, `TResult`, `TParams` |

### Aturan Khusus

- Boolean variable/function: gunakan `is`, `has`, `should` prefix — `isOpen`, `hasQueue`, `shouldRetry`
- Async function: tidak perlu `Async` suffix — return type sudah mengindikasikan
- Factory function: gunakan `create` prefix — `createRetryPolicy()`
- Event handler: gunakan `on` prefix — `onBusy()`, `onRetry()`

## 6. Aturan Struktur Folder

```
bunql/
├── src/
│   ├── index.ts               ← Main entry point, re-exports public API
│   ├── bunql.ts               ← BunQL facade class
│   ├── write-queue.ts         ← WriteQueue implementation
│   ├── transaction-manager.ts  ← TransactionManager implementation
│   ├── retry-policy.ts         ← RetryPolicy with exponential backoff
│   ├── statement-cache.ts     ← Prepared statement caching
│   ├── types/
│   │   ├── index.ts           ← Re-export all types
│   │   ├── options.ts         ← Configuration/option types
│   │   └── result.ts          ← Result type definitions
│   └── errors/
│       ├── index.ts           ← Re-export all errors
│       ├── bunql-error.ts     ← Base error class
│       ├── busy-error.ts      ← SQLITE_BUSY error
│       ├── transaction-error.ts
│       ├── queue-error.ts
│       └── connection-error.ts
├── test/
│   ├── bunql.test.ts
│   ├── write-queue.test.ts
│   ├── transaction.test.ts
│   ├── retry.test.ts
│   ├── concurrency.test.ts
│   └── helpers/
│       └── setup.ts           ← Test database setup/teardown
├── bench/
│   ├── simple-read.bench.ts
│   ├── simple-write.bench.ts
│   ├── concurrent-write.bench.ts
│   └── transaction.bench.ts
├── examples/
│   ├── basic-usage.ts
│   ├── transactions.ts
│   └── batch-operations.ts
├── PROJECT.md
├── RULES.md
├── TODO.md
├── CHANGELOG.md
├── package.json
├── tsconfig.json
└── .gitignore
```

### Aturan Tambahan

- Satu class/module per file — tidak boleh multi-class dalam satu file
- `index.ts` di setiap folder hanya untuk re-exports, tidak boleh berisi logic
- `types/` folder hanya berisi type definitions, tidak ada runtime logic
- `test/` file naming: `<module-name>.test.ts`
- `bench/` file naming: `<scenario>.bench.ts`
- Test helpers di `test/helpers/` — reusable setup/teardown

## 7. Aturan Changelog

Gunakan format [Keep a Changelog](https://keepachangelog.com/):

```markdown
# Changelog

## [Unreleased]

## [0.1.0] - 2026-01-01

### Added
- Feature description.

### Changed
- Change description.

### Fixed
- Fix description.

### Removed
- Removal description.
```

- Versi mengikuti [SemVer](https://semver.org/): `MAJOR.MINOR.PATCH`
- `Unreleased` section selalu ada di atas untuk work in progress
- Setiap release harus memiliki tanggal
- Category wajib: `Added`, `Changed`, `Fixed`, `Removed`
- Tidak boleh ada entry tanpa category

## 8. Best Practice Bun Runtime

- Gunakan `bun:sqlite` — **tidak boleh** `better-sqlite3` atau wrapper lain
- Gunakan `Bun.file()` untuk file I/O jika diperlukan
- Gunakan `Bun.inspect()` untuk custom error formatting
- Gunakan `Bun.write()` untuk file output
- Gunakan Bun test runner (`bun test`) — tidak boleh vitest, jest, atau runner lain
- Manfaatkan `Bun.sleep()` untuk delay/retry — lebih efficient daripada `setTimeout`
- ESM `import`/`export` — tidak boleh CommonJS interop
- Jangan gunakan Node.js polyfills — leverage Bun native APIs
- Gunakan `Bun.env` untuk environment variables, bukan `process.env`
- Build menggunakan `bun build` — tidak perlu bundler tambahan

## 9. Safety Rules AI Agent

| # | Rule | Detail |
|---|------|--------|
| 1 | **Workspace-only** | Hanya bekerja di dalam folder project aktif (`bunql/`). Dilarang mengakses parent directory. |
| 2 | **No destructive delete** | Dilarang menghapus file tanpa instruksi eksplisit dari user. Tidak boleh `rm -rf` atau equivalent. |
| 3 | **No dangerous commands** | Dilarang menjalankan command yang berbahaya bagi system (`format`, `del /s`, dll). |
| 4 | **No mass rename** | Dilarang melakukan mass rename tanpa konfirmasi user terlebih dahulu. |
| 5 | **Plan first** | Semua perubahan besar wajib menjelaskan rencana terlebih dahulu sebelum eksekusi. |
| 6 | **Justified dependencies** | Dependency baru wajib memiliki alasan jelas yang didokumentasikan. |
| 7 | **No config overwrite** | Jangan overwrite file konfigurasi (`tsconfig.json`, `package.json`, dsb) tanpa izin user. |
| 8 | **Minimal changes** | Selalu utamakan perubahan minimal — jangan rewrite jika edit cukup. |
| 9 | **No auto-commit** | Jangan commit ke git tanpa instruksi eksplisit dari user. |
| 10 | **Scope limit** | Semua operasi harus terbatas pada folder project aktif. Jangan modify file di luar workspace. |