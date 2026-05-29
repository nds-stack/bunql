import { Database } from "bun:sqlite";
import { ConnectionError } from "./errors/connection-error.ts";
import type { BunQLOptions } from "./types/index.ts";

export interface DbInitResult {
  db: Database;
  pageSize: number;
  name: string;
  memory: boolean;
}

export function createDbInstance(path: string, options?: BunQLOptions): DbInitResult {
  validateURI(path);

  const config = resolveInitConfig(options);

  if (config.readerPoolSize > 0 && !config.wal) {
    throw new ConnectionError(
      "Reader pool requires WAL mode. Set `wal: true` or remove `readerPool` option.",
    );
  }

  const dbOptions: { readonly?: boolean; safeIntegers?: boolean; create?: boolean } = {};
  if (config.readonly) dbOptions.readonly = true;
  if (config.safeIntegers) dbOptions.safeIntegers = true;
  dbOptions.create = true;

  let db: Database;
  try {
    db = options?.dbInstance ?? new Database(path, dbOptions);
  } catch (error) {
    throw new ConnectionError(`Failed to open database: ${path}`, {
      cause: error instanceof Error ? error : undefined,
    });
  }

  if (config.wal && !config.readonly && !options?.dbInstance) {
    db.run("PRAGMA journal_mode=WAL");
  }
  if (!options?.dbInstance) {
    db.run(`PRAGMA synchronous=${config.synchronous}`);
    db.run(`PRAGMA cache_size=${config.cacheSize}`);
    if (config.foreignKeys) db.run("PRAGMA foreign_keys=ON");
    if (config.busyTimeout > 0) db.run(`PRAGMA busy_timeout=${config.busyTimeout}`);
    if (config.autoVacuum !== "NONE") db.run(`PRAGMA auto_vacuum=${config.autoVacuum}`);
  }

  const pageSize = (db.prepare("PRAGMA page_size").get() as Record<string, number>)?.["page_size"] ?? 4096;
  let name = "";
  let memory = false;
  try {
    name = (db as unknown as { filename?: string }).filename ?? (db as unknown as { name?: string }).name ?? "";
    memory = (db as unknown as { memory?: boolean }).memory ?? false;
  } catch { /* ignore */ }

  return { db, pageSize, name, memory };
}

function validateURI(path: string): void {
  if (path.startsWith("mongodb://") || path.startsWith("mongodb+srv://")) {
    throw new Error(`MongoDB driver is available as MongoDriver: import { MongoDriver } from "@nds-stack/bunql/driver"; const db = new MongoDriver("${path}");`);
  }
  if (path.startsWith("redis://") || path.startsWith("rediss://")) {
    throw new Error(`Redis driver is available as RedisDriver: import { RedisDriver } from "@nds-stack/bunql/driver"; const db = new RedisDriver("${path}");`);
  }
  if (path.startsWith("postgres://") || path.startsWith("postgresql://")) {
    throw new Error(`PostgreSQL driver is available as PGDriver: import { PGDriver } from "@nds-stack/bunql/driver"; const db = new PGDriver("${path}");`);
  }
  if (path.startsWith("mysql://") || path.startsWith("mariadb://")) {
    throw new Error(`MySQL driver is available as MySQLDriver: import { MySQLDriver } from "@nds-stack/bunql/driver"; const db = new MySQLDriver("${path}");`);
  }
}

interface InitConfig {
  wal: boolean;
  readonly: boolean;
  busyTimeout: number;
  synchronous: string;
  cacheSize: number;
  foreignKeys: boolean;
  safeIntegers: boolean;
  readerPoolSize: number;
  autoVacuum: string;
}

function resolveInitConfig(options?: BunQLOptions): InitConfig {
  return {
    wal: options?.wal ?? true,
    readonly: options?.readonly ?? false,
    busyTimeout: options?.busyTimeout ?? 5000,
    synchronous: options?.synchronous ?? "NORMAL",
    cacheSize: options?.cacheSize ?? -2000,
    foreignKeys: options?.foreignKeys ?? true,
    safeIntegers: options?.safeIntegers ?? false,
    readerPoolSize: options?.readerPool ?? 0,
    autoVacuum: options?.pragma?.autoVacuum ?? "NONE",
  };
}
