/**
 * @module query/mql-builder
 * @description MongoDB-style query builder — chain API with cross-backend support.
 */

import { parseMQL } from "../parser/mql-parser.ts";
import { astToMongo } from "../translator/to-mongodb.ts";

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  duration?: number;
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export class MqlQuery {
  readonly collection: string;
  #method = "find";
  #args: unknown[] = [];
  #executor: Executor | null = null;

  constructor(collection: string, executor?: Executor) {
    this.collection = collection;
    this.#executor = executor ?? null;
  }

  find(filter?: Record<string, unknown>, options?: Record<string, unknown>): this {
    this.#method = "find";
    this.#args = [filter ?? {}, options].filter(Boolean);
    return this;
  }

  project(fields: Record<string, number | boolean>): this {
    const args = this.#args[0] ? [{ ...this.#args[0] as Record<string, unknown>, projection: fields }] : [{ projection: fields }];
    this.#args = args;
    return this;
  }

  sort(fields: Record<string, 1 | -1>): this {
    const args = this.#args[0] ? [{ ...this.#args[0] as Record<string, unknown>, sort: fields }] : [{ sort: fields }];
    this.#args = args;
    return this;
  }

  limit(n: number): this {
    const args = this.#args[0] ? [{ ...this.#args[0] as Record<string, unknown>, limit: n }] : [{ limit: n }];
    this.#args = args;
    return this;
  }

  skip(n: number): this {
    const args = this.#args[0] ? [{ ...this.#args[0] as Record<string, unknown>, skip: n }] : [{ skip: n }];
    this.#args = args;
    return this;
  }

  aggregate(pipeline: Record<string, unknown>[]): this {
    this.#method = "aggregate";
    this.#args = [pipeline];
    return this;
  }

  insertOne(doc: Record<string, unknown>): this {
    this.#method = "insertOne";
    this.#args = [doc];
    return this;
  }

  insertMany(docs: Record<string, unknown>[]): this {
    this.#method = "insertMany";
    this.#args = [docs];
    return this;
  }

  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>): this {
    this.#method = "updateOne";
    this.#args = [filter, update];
    return this;
  }

  deleteOne(filter: Record<string, unknown>): this {
    this.#method = "deleteOne";
    this.#args = [filter];
    return this;
  }

  toArray<T = Record<string, unknown>>(): T[] | Promise<T[]> {
    if (!this.#executor) return [];
    const result = this.#executor.executeMQL(this.collection, this.#method, this.#args);
    if (result instanceof Promise) {
      return result.then((r) => r.rows as T[]);
    }
    return result.rows as T[];
  }

  run(): RunResult | Promise<RunResult> {
    return this.#executor!.executeMQLRun(this.collection, this.#method, this.#args);
  }

  toCommand(): Record<string, unknown> {
    const node = parseMQL(this.collection, this.#method, this.#args);
    const mongoCmd = astToMongo(node as Parameters<typeof astToMongo>[0]);
    return {
      method: mongoCmd.method,
      collection: mongoCmd.collection,
      args: mongoCmd.args,
    };
  }
}

export interface Executor {
  executeMQL(collection: string, method: string, args: unknown[]): QueryResult | Promise<QueryResult>;
  executeMQLRun(collection: string, method: string, args: unknown[]): RunResult | Promise<RunResult>;
}

export type { };
