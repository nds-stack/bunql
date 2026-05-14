/**
 * @module types-options
 * @description Configuration and option type definitions.
 */
import type { SQLQueryBindings } from "bun:sqlite";
import type { CheckpointMode } from "./result.ts";

export interface RetryConfig {
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
  jitter?: boolean;
}

export interface MaintenanceConfig {
  checkpoint?: {
    enabled: boolean;
    intervalMs?: number;
    pagesThreshold?: number;
    mode?: CheckpointMode;
  };
  vacuum?: {
    enabled: boolean;
    intervalMs?: number;
    mode?: "incremental" | "full";
    pagesPerStep?: number;
  };
  backup?: {
    enabled: boolean;
    intervalMs: number;
    path: string;
    maxBackups?: number;
  };
  integrityCheck?: {
    enabled: boolean;
    intervalMs: number;
  };
}

export interface FTS5Options {
  tokenize?: string;
  content?: string;
  prefix?: number[];
}

export interface BunQLOptions {
  wal?: boolean;
  readonly?: boolean;
  busyTimeout?: number;
  synchronous?: "OFF" | "NORMAL" | "FULL" | "EXTRA";
  cacheSize?: number;
  foreignKeys?: boolean;
  retry?: RetryConfig;
  logger?: Logger;
  hooks?: BunQLHooks;
  events?: EventHandlers;
  readerPool?: number;
  maintenance?: MaintenanceConfig;
  slowQueryThreshold?: number;
  pragma?: {
    autoVacuum?: "NONE" | "FULL" | "INCREMENTAL";
  };
}

export interface BatchOperation {
  sql: string;
  params?: SQLQueryBindings[];
}

export type Logger = Pick<Console, "error" | "warn" | "info" | "debug">;

export interface BunQLHooks {
  beforeWrite?: (sql: string, params: unknown[]) => void;
  afterWrite?: (sql: string, params: unknown[], durationMs: number) => void;
  beforeTransaction?: () => void;
  afterTransaction?: (durationMs: number, success: boolean) => void;
}

export interface EventHandlers {
  onBusy?: (attempt: number, delayMs: number) => void;
  onRetry?: (attempt: number, delayMs: number, error: Error) => void;
  onDrain?: () => void;
  onError?: (error: Error) => void;
  onSlowQuery?: (sql: string, durationMs: number) => void;
}

export interface BunQLConfig {
  wal: boolean;
  readonly: boolean;
  busyTimeout: number;
  synchronous: "OFF" | "NORMAL" | "FULL" | "EXTRA";
  cacheSize: number;
  foreignKeys: boolean;
  retry: Required<RetryConfig>;
  readerPoolSize: number;
  maintenance?: MaintenanceConfig;
  slowQueryThreshold: number;
  autoVacuum: "NONE" | "FULL" | "INCREMENTAL";
  logger?: Logger;
  hooks?: BunQLHooks;
  events?: EventHandlers;
}