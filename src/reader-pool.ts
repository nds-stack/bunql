/**
 * @module reader-pool
 * @description Multi-connection read pool for parallel read queries.
 */
import { Database } from "bun:sqlite";
import { ConnectionError } from "./errors/connection-error.ts";
import { StatementCache } from "./statement-cache.ts";

interface PoolEntry {
  db: Database;
  cache: StatementCache;
}

export class ReaderPool {
  #entries: PoolEntry[] = [];
  #index = 0;

  constructor(path: string, size: number) {
    try {
      this.#entries = Array.from({ length: size }, () => {
        const db = new Database(path, { readonly: true });
        return { db, cache: new StatementCache(db) };
      });
    } catch (error) {
      throw new ConnectionError(
        `Failed to open reader pool connections: ${path}`,
        { cause: error instanceof Error ? error : undefined },
      );
    }
  }

  get size(): number {
    return this.#entries.length;
  }

  next(): { db: Database; cache: StatementCache } {
    if (this.#entries.length === 0) {
      throw new ConnectionError("Reader pool is empty");
    }
    const entry = this.#entries[this.#index]!;
    this.#index = (this.#index + 1) % this.#entries.length;
    return entry;
  }

  cacheStats(): { hits: number; misses: number; size: number } {
    let hits = 0;
    let misses = 0;
    let size = 0;
    for (const entry of this.#entries) {
      hits += entry.cache.hits;
      misses += entry.cache.misses;
      size += entry.cache.size;
    }
    return { hits, misses, size };
  }

  close(): void {
    for (const entry of this.#entries) {
      entry.cache.clear();
      try {
        entry.db.close();
      } catch (error) {
        console.error("[BunQL:ReaderPool] Error closing reader connection:", error); // eslint-disable-line no-console
      }
    }
    this.#entries = [];
  }
}
