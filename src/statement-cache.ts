/**
 * @module statement-cache
 * @description LRU cache for prepared statements with automatic eviction.
 */
import type { Database, Statement as BunStatement } from "bun:sqlite";

interface CacheEntry {
  stmt: BunStatement;
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
      this.#cache.delete(sql);
      this.#cache.set(sql, entry);
      return entry.stmt;
    }

    this.#misses++;
    if (this.#cache.size >= this.#maxSize) {
      this.#evict();
    }

    const stmt = this.#db.prepare(sql);
    this.#cache.set(sql, { stmt });
    return stmt;
  }

  remove(sql: string): void {
    const entry = this.#cache.get(sql);
    if (entry) {
      entry.stmt.finalize();
      this.#cache.delete(sql);
    }
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
    const firstKey = this.#cache.keys().next().value;
    if (firstKey !== undefined) {
      const entry = this.#cache.get(firstKey);
      entry?.stmt.finalize();
      this.#cache.delete(firstKey);
    }
  }
}