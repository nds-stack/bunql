import type { Database, Statement as BunStatement } from "bun:sqlite";

interface CacheEntry {
  stmt: BunStatement;
  lastUsed: number;
}

export class StatementCache {
  #db: Database;
  #cache = new Map<string, CacheEntry>();
  #maxSize: number;
  #hits = 0;
  #misses = 0;

  constructor(db: Database, maxSize = 100) {
    this.#db = db;
    this.#maxSize = maxSize;
  }

  get hits(): number {
    return this.#hits;
  }

  get misses(): number {
    return this.#misses;
  }

  get size(): number {
    return this.#cache.size;
  }

  get(sql: string): BunStatement {
    const entry = this.#cache.get(sql);
    if (entry) {
      this.#hits++;
      entry.lastUsed = performance.now();
      return entry.stmt;
    }

    this.#misses++;
    if (this.#cache.size >= this.#maxSize) {
      this.#evict();
    }

    const stmt = this.#db.prepare(sql);
    this.#cache.set(sql, { stmt, lastUsed: performance.now() });
    return stmt;
  }

  clear(): void {
    for (const entry of this.#cache.values()) {
      entry.stmt.finalize();
    }
    this.#cache.clear();
    this.#hits = 0;
    this.#misses = 0;
  }

  #evict(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.#cache) {
      if (entry.lastUsed < oldestTime) {
        oldestTime = entry.lastUsed;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      const entry = this.#cache.get(oldestKey);
      entry?.stmt.finalize();
      this.#cache.delete(oldestKey);
    }
  }
}