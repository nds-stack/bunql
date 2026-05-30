# Design Decisions — @nds-stack/bunql

## Filosofi

**BunQL bukan query builder.** BunQL adalah **query translator** — ia menerima SQL atau MQL, memahami artinya via Universal AST, lalu menghasilkan query yang tepat untuk backend target. Backend tidak harus mendukung semua fitur; BunQL yang memutuskan: emit langsung jika native, approximasi jika mungkin, atau error eksplisit jika tidak ada padanan.

---

## 1. JOIN FULL/CROSS/NATURAL → MongoDB

### Latar Belakang

User menulis SQL `FULL JOIN` dan ingin migrate dari MySQL ke MongoDB tanpa mengubah query. BunQL harus menangani transparan — jangan throw error, jangan crash aplikasi.

### Masalah

SQL `FULL JOIN` mengembalikan semua baris dari kedua tabel, termasuk yang tidak memiliki pasangan. MongoDB `$lookup` bersifat **left-biased** — anchor di collection kiri (FROM), lalu mencari pasangan di collection kanan. Dokumen di collection kanan yang tidak memiliki pasangan di collection kiri **tidak akan muncul**.

### Keputusan

**Best-effort approximation via `$lookup` + `preserveNullAndEmptyArrays: true`.**

```javascript
// SQL:  SELECT * FROM users FULL JOIN orders ON u.id = o.user_id
// MQL:  
db.users.aggregate([
  { $lookup: { from: "orders", localField: "id", foreignField: "user_id", as: "orders" } },
  { $unwind: { path: "$orders", preserveNullAndEmptyArrays: true } }
])
```

### Yang Didapat

| Aspek | FULL JOIN SQL | MongoDB approx |
|:------|:-------------:|:--------------:|
| Baris match | ✅ | ✅ |
| User tanpa order | ✅ | ✅ (`preserveNullAndEmptyArrays`) |
| Order tanpa user | ✅ | ❌ **hilang** |

### Yang Hilang

Data dari collection kanan (orders) yang tidak memiliki pasangan di collection kiri (users). Ini adalah limitasi fundamental MongoDB aggregate pipeline, bukan bug di BunQL. Tidak ada operasi setara `RIGHT JOIN` atau `FULL JOIN` dalam aggregation pipeline.

### Rekomendasi

Jika FULL JOIN semantic diperlukan secara akurat, gunakan SQL backend (SQLite, PostgreSQL, MySQL). MongoDB approximation cocok untuk skenario dimana foreign key constraint menjamin semua record di collection kanan memiliki pasangan.

---

## 2. Zero Dependency Mandate

### Latar Belakang

Semua driver database (MongoDB, Redis, PostgreSQL, MySQL) diimplementasikan via `Bun.connect()` — custom TCP + wire protocol. Tidak ada npm packages seperti `mongodb`, `ioredis`, `pg`, `mysql2`.

### Alasan

1. **Bundle size** — Hindari ribuan LOC polyfill untuk runtime Node.js
2. **Full control** — Bisa optimasi protocol sesuai kebutuhan BunQL
3. **No breaking changes** — Bebas dari dependency drift
4. **Bun-native** — Manfaatkan `Bun.connect()`, `Bun.file()`, `Bun.sleep()` langsung

### Tradeoff

- Development time lebih lama (setiap protocol di-reimplement dari scratch)
- Risk of protocol incompatibility (harus update manual jika protocol berubah)
- Tidak bisa manfaatkan fitur yang hanya ada di driver npm (misal advanced connection pooling)

---

## 3. Custom Wire Protocol vs Bun.SQL()

Bun memiliki API `Bun.SQL()` untuk PostgreSQL dan MySQL. Kami memilih tidak menggunakannya.

### Alasan

1. **Konsistensi** — Semua driver (MongoDB, Redis, PG, MySQL) menggunakan pola yang sama: `Bun.connect()` → TCP → kustom protocol. Tidak ada preferensi khusus ke satu backend.
2. **Zero deps** — `Bun.SQL()` mungkin memiliki dependency chain sendiri.
3. **Full control** — Kami bisa handle auth, pooling, error handling sesuai kebutuhan BunQL.

---

## 4. ColumnExpr adalah Interface, Bukan Union Type

### Latar Belakang

Di banyak proyek TypeScript, discriminated union (`type A = B | C | D`) adalah default. BunQL memilih single interface untuk `ColumnExpr`:

```typescript
export interface ColumnExpr {
  type: "column" | "alias" | "wildcard" | "literal" | "function" | "binary" | "case";
  name?: string;
  table?: string;
  alias?: string;
  value?: Literal;
  func?: string;
  args?: ColumnExpr[];
  distinct?: boolean;
  left?: ColumnExpr;
  right?: ColumnExpr;
  op?: string;
  caseValue?: ColumnExpr;
  branches?: { when: ColumnExpr | Condition; then: ValueExpr }[];
  else?: ValueExpr;
  over?: OverClause;
}
```

### Alasan

1. **Extensibility** — Tambah tipe baru = tambah string literal ke `type` + optional fields. Tidak perlu restrukturisasi union.
2. **Parser simplicity** — `#parseColumnExpr()` return `ColumnExpr`, tidak perlu overload atau generic.
3. **Translator simplicity** — Satu `switch (col.type)` di `colSQL()`, tidak perlu handle multiple function signatures.

### Tradeoff

- Semua field optional — TypeScript tidak bisa enforce exhaustive check tanpa boilerplate.
- Object besar dengan banyak field undefined untuk tipe sederhana (misal `{ type: "wildcard" }`).

### Catatan

Qwen (LLM) sering salah menganggap `ColumnExpr` sebagai union type. Selalu refer ke AST aktual sebelum memberikan saran.

---

## 5. MQL di SQL Backend: Translasi, Bukan Passthrough

### Latar Belakang

MQL (MongoDB Query Language) bisa ditulis user dan dijalankan di SQLite, PostgreSQL, atau MySQL.

### Cara Kerja

```
User MQL → mql-parser.ts → Universal AST → to-sql.ts → SQL string → StatementCache → backend
```

### Cakupan

- Filter operators: `$eq`, `$gt`, `$in`, `$regex`, `$elemMatch`, `$expr`, dll → SQL WHERE
- Update operators: `$inc`, `$unset`, `$push`, `$pull`, `$min`, `$max`, `$pop`, `$rename` → SQL UPDATE SET
- Accumulators: `$sum`, `$avg`, `$push`, `$addToSet` → SQL GROUP BY + aggregate functions
- Pipeline stages: `$match`, `$group`, `$sort`, `$limit`, `$skip`, `$lookup`, `$unwind`, `$sample`, `$addFields` → SQL SELECT / JOIN / subquery

### Limitasi

Beberapa MQL operator tidak memiliki padanan SQL yang sempurna:

| Operator | SQL Approximation | Loss |
|----------|:----------------:|:----:|
| `$unwind` | ❌ Tidak ada | SQLite tidak punya UNNEST |
| `$pull` | `SET col = ?` | Bukan array removal sejati |
| `$type` PG | `1=1` (no-op) | Type checking silent |
| `$elemMatch` MySQL | `JSON_SEARCH()` | Simple value only |

---

## 6. Parser: Recursive Descent, Zero Dependencies

### Latar Belakang

SQL parser ditulis manual, bukan menggunakan library seperti `sql-parser`, `jsep`, atau `peggy`.

### Alasan

1. **Subset SQL** — BunQL tidak perlu full SQL standard. Subset yang didukung < 800 LOC parser + < 130 LOC lexer.
2. **Kontrol penuh** — Setiap token, error message, dan recovery bisa disesuaikan.
3. **Zero deps** — Sesuai mandate.

### Konsekuensi

- Setiap fitur SQL baru perlu implementasi lexer keyword + parser case + handler di `#parse*()` method.
- Error recovery terbatas — parser throws `ParseError` dengan position info, tidak ada auto-correction.

---

## 7. Error Handling: Typed Hierarchy

### Keputusan

Semua error extends `BunQLError` base class dengan `.cause` properti yang menyimpan error asli.

```
BunQLError (base)
├── BusyError         — SQLITE_BUSY
├── TransactionError  — Transaction scope failure
├── QueueError        — WriteQueue internal failure
├── ConnectionError   — Database connection failure
├── ParseError        — SQL/MQL parsing error
├── DriverError       — Wire protocol / auth / timeout
└── NotFoundError     — Entity not found
```

### Alasan

- **Tidak ada swallowed errors** — Original error selalu tersedia via `.cause`.
- **Type-safe** — User bisa `catch (e instanceof BusyError)` untuk retry logic.
- **Backend-agnostic** — Error yang sama untuk SQLite, PG, MySQL, MongoDB, Redis.

---

## 8. Parameter Binding: ParamRef AST Node

### Keputusan

Parameter `?` atau `$N` di SQL di-parse menjadi `ParamRef` AST node:

```typescript
export interface ParamRef {
  type: "param";
  index: number;
}
```

Translator bertanggung jawab me-resolve `ParamRef` ke positional parameter di query output.

### Alasan

- Parser tidak usah tahu tipe data parameter.
- Translator bisa output `?` (SQLite/MySQL) atau `$1` (PostgreSQL) sesuai dialect.
- MongoDB translator resolve param value langsung ke dalam filter object.

---

## 9. Versioning & Release Strategy

### Pre-Release Checklist

Setiap rilis ke npm (beta) harus memenuhi:

- [ ] 434+ tests pass
- [ ] `bun run lint` = 0 warnings
- [ ] `tsc --noEmit` = 0 errors
- [ ] `bun run build` = success
- [ ] README matrix akurat (cross-check dengan kode)
- [ ] CHANGELOG update
- [ ] Git tag sesuai versi

### Filosofi Beta

- `0.3.0-beta.N` — Iterasi cepat, fitur baru per beta
- `0.3.0-rc.1` — Feature freeze, hanya bugfix
- `0.3.0` — Stable: semua fitur terdokumentasi, backend parity acceptable, no 🔴 blocking issues

### Aturan Version Bump

- **Perubahan besar** (fitur baru, parser baru, backend baru) → bump minor: `beta.N` → `beta.N+1`
- **Perubahan kecil** (dokumentasi, typo, refactor internal) → tetap di versi yang sama, akumulasi
