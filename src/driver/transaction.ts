/**
 * @module driver/transaction
 * @description Unified transaction manager for all database backends.
 */

export interface TransactionBackend {
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  savepoint(name: string): Promise<void>;
  releaseSavepoint(name: string): Promise<void>;
  rollbackTo(name: string): Promise<void>;
}

export interface TxContext {
  run(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowid: number | bigint }>;
  query(sql: string, params?: unknown[]): Promise<{ columns: string[]; rows: Record<string, unknown>[] }>;
  savepoint(name: string): Promise<void>;
  rollbackTo(name: string): Promise<void>;
}

export class TransactionManager {
  readonly backend: TransactionBackend;
  #depth = 0;

  constructor(backend: TransactionBackend) {
    this.backend = backend;
  }

  get depth(): number { return this.#depth; }

  async begin(): Promise<void> {
    if (this.#depth === 0) {
      await this.backend.begin();
    } else {
      await this.backend.savepoint(`sp_${this.#depth}`);
    }
    this.#depth++;
  }

  async commit(): Promise<void> {
    if (this.#depth <= 0) throw new Error("No active transaction");
    this.#depth--;
    if (this.#depth === 0) {
      await this.backend.commit();
    } else {
      await this.backend.releaseSavepoint(`sp_${this.#depth}`);
    }
  }

  async rollback(): Promise<void> {
    if (this.#depth <= 0) throw new Error("No active transaction");
    this.#depth--;
    if (this.#depth === 0) {
      await this.backend.rollback();
    } else {
      await this.backend.rollbackTo(`sp_${this.#depth}`);
    }
  }

  async transaction<T>(fn: (ctx: TxContext) => Promise<T>): Promise<T> {
    const isOuter = this.#depth === 0;
    await this.begin();
    try {
      const result = await fn(this.#createCtx());
      if (isOuter) await this.commit();
      return result;
    } catch (err) {
      await this.rollback();
      throw err;
    }
  }

  #createCtx(): TxContext {
    return {
      run: async (sql, params) => {
        // Basic implementation — subclasses can override
        throw new Error("Not implemented");
      },
      query: async (sql, params) => {
        throw new Error("Not implemented");
      },
      savepoint: (name) => this.backend.savepoint(name),
      rollbackTo: (name) => this.backend.rollbackTo(name),
    };
  }
}

export type { };
