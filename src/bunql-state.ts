import { Database } from "bun:sqlite";
import { WriteQueue } from "./write-queue.ts";
import { RetryPolicy, DEFAULT_RETRY_CONFIG } from "./retry-policy.ts";
import { TransactionManager } from "./transaction-manager.ts";
import { StatementCache } from "./statement-cache.ts";
import { ReaderPool } from "./reader-pool.ts";
import { FTS5Helper } from "./fts5.ts";
import type { BunQLOptions, BunQLConfig, BunQLMetrics, CacheStats, RetryConfig } from "./types/index.ts";
import { createDbInstance } from "./bunql-init.ts";

export interface BunQLState {
  db: Database;
  config: BunQLConfig;
  writeQueue: WriteQueue;
  retryPolicy: RetryPolicy;
  txManager: TransactionManager;
  statementCache: StatementCache;
  readerPool: ReaderPool | null;
  fts: FTS5Helper;
  closed: boolean;
  logger?: { debug?: (msg: string) => void; warn?: (msg: string) => void; info?: (msg: string) => void; error?: (msg: string) => void };
  onError?: (error: Error) => void;
  maintenanceTimer: Timer | null;
  maintenance: import("./types/index.ts").MaintenanceConfig | undefined;
  metricsEnabled: boolean;
  queryTimeoutMs: number;
  extractColumns: boolean;
  pageSize: number;
  name: string;
  memory: boolean;
  verbose: ((sql: string) => void) | null;
  metricsData: { writes: { total: number; failed: number; retried: number }; reads: { total: number } };
  ensureOpen(): void;
  log(level: "debug" | "warn" | "info" | "error", message: string): void;
  verboseLog(sql: string): void;
  metrics(): BunQLMetrics;
  cacheStats(): CacheStats;
}

export function createState(path: string, options?: BunQLOptions): BunQLState {
  const config = resolveConfig(options);
  const { db, pageSize, name, memory } = createDbInstance(path, options);
  const logger = config.logger;
  const metricsEnabled = config.metricsEnabled;

  let verbose: ((sql: string) => void) | null = null;
  if (typeof config.verbose === "function") verbose = config.verbose;
  else if (config.verbose === true) verbose = (sql: string) => logger?.debug?.(`[BunQL] ${sql}`);

  const writeQueue = new WriteQueue();
  const retryPolicy = new RetryPolicy(config.retry);
  const statementCache = new StatementCache(db);
  const txManager = new TransactionManager(db, writeQueue, config.hooks, logger);
  const fts = new FTS5Helper(db);
  let readerPool: ReaderPool | null = null;
  if (config.readerPoolSize > 0 && !options?.dbInstance) {
    readerPool = new ReaderPool(path, config.readerPoolSize);
  }

  let _closed = false;
  const metricsData = { writes: { total: 0, failed: 0, retried: 0 }, reads: { total: 0 } };

  const state: BunQLState = {
    db, config, writeQueue, retryPolicy, txManager, statementCache, readerPool, fts,
    get closed() { return _closed; },
    set closed(v) { _closed = v; },
    logger, maintenanceTimer: null,
    maintenance: config.maintenance, metricsEnabled,
    queryTimeoutMs: config.queryTimeoutMs, extractColumns: config.extractColumns,
    pageSize, name, memory, verbose, metricsData,

    ensureOpen() { if (_closed) throw new Error("Database is closed. No operations allowed."); },
    log(l, m) { logger?.[l]?.(`[BunQL] ${m}`); },
    verboseLog(sql) { verbose?.(sql); },

    metrics(): BunQLMetrics {
      const tx = txManager.metrics;
      return {
        writes: { ...metricsData.writes },
        reads: { ...metricsData.reads },
        queue: { currentSize: writeQueue.size, peakSize: writeQueue.peakSize, totalEnqueued: writeQueue.totalEnqueued },
        transactions: { committed: tx.committed, rolledBack: tx.rolledBack },
      };
    },

    cacheStats(): CacheStats {
      let hits = statementCache.hits;
      let misses = statementCache.misses;
      if (readerPool) {
        const ps = readerPool.cacheStats();
        hits += ps.hits; misses += ps.misses;
      }
      const total = hits + misses;
      return { size: statementCache.size + (readerPool?.cacheStats().size ?? 0), hits, misses, hitRate: total > 0 ? hits / total : 0 };
    },
  };

  if (config.events) {
    if (config.events.onBusy) {
      retryPolicy.onBusy = (attempt, delay) => {
        if (metricsEnabled) metricsData.writes.retried++;
        config.events!.onBusy!(attempt, delay);
      };
    }
    if (config.events.onRetry) retryPolicy.onRetry = config.events.onRetry;
    if (config.events.onDrain) writeQueue.onDrain = config.events.onDrain;
    if (config.events.onError) state.onError = config.events.onError;
  }

  return state;
}

export function resolveConfig(options?: BunQLOptions): BunQLConfig {
  const retry: Required<RetryConfig> = { ...DEFAULT_RETRY_CONFIG, ...options?.retry };
  return {
    wal: options?.wal ?? true,
    readonly: options?.readonly ?? false,
    busyTimeout: options?.busyTimeout ?? 5000,
    synchronous: options?.synchronous ?? "NORMAL",
    cacheSize: options?.cacheSize ?? -2000,
    foreignKeys: options?.foreignKeys ?? true,
    safeIntegers: options?.safeIntegers ?? false,
    retry,
    readerPoolSize: options?.readerPool ?? 0,
    maintenance: options?.maintenance,
    slowQueryThreshold: options?.slowQueryThreshold ?? 0,
    metricsEnabled: options?.metricsEnabled ?? false,
    queryTimeoutMs: options?.queryTimeoutMs ?? 0,
    extractColumns: options?.extractColumns ?? false,
    autoVacuum: options?.pragma?.autoVacuum ?? "NONE",
    verbose: options?.verbose ?? null,
    transactionMode: options?.transactionMode ?? "immediate",
    logger: options?.logger,
    hooks: options?.hooks,
    events: options?.events,
  };
}
