import type { SQLQueryBindings } from "bun:sqlite";

export interface RetryConfig {
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
  jitter?: boolean;
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
}

export interface BunQLConfig {
  wal: boolean;
  readonly: boolean;
  busyTimeout: number;
  synchronous: "OFF" | "NORMAL" | "FULL" | "EXTRA";
  cacheSize: number;
  foreignKeys: boolean;
  retry: Required<RetryConfig>;
  logger?: Logger;
  hooks?: BunQLHooks;
  events?: EventHandlers;
}