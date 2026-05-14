/**
 * @module index
 * @description Main entry point — re-exports public API.
 */
export { BunQL } from "./bunql.ts";
export type {
  BunQLOptions,
  RetryConfig,
  QueryResult,
  RunResult,
  Statement,
  BatchOperation,
  TransactionContext,
  BunQLMetrics,
  CacheStats,
  CheckpointMode,
  CheckpointResult,
  WalStatus,
  BackupResult,
  VacuumResult,
  FTS5Options,
  FTSResult,
  MaintenanceConfig,
} from "./bunql.ts";
export type { ServerOptions } from "./types/result.ts";

export {
  BunQLError,
  BusyError,
  TransactionError,
  QueueError,
  ConnectionError,
} from "./errors/index.ts";

export { WriteQueue } from "./write-queue.ts";
export { RetryPolicy, DEFAULT_RETRY_CONFIG } from "./retry-policy.ts";
export { TransactionManager } from "./transaction-manager.ts";
export { StatementCache } from "./statement-cache.ts";
export { ReaderPool } from "./reader-pool.ts";
export { FTS5Helper } from "./fts5.ts";