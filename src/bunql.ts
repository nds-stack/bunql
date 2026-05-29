/**
 * @module bunql
 * @description BunQL facade — thin re-export layer. Full implementation in bunql-core.ts.
 */
export { BunQL } from "./bunql-core.ts";
export type { TransactionContext } from "./transaction-manager.ts";
export type {
  BunQLOptions,
  RetryConfig,
  QueryResult,
  RunResult,
  Statement,
  ColumnInfo,
  BatchOperation,
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
  TransactionMode,
  PragmaOptions,
} from "./types/index.ts";
export type { ServerOptions } from "./types/result.ts";
