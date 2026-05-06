import type { RetryConfig } from "./types/options.ts";

export const DEFAULT_RETRY_CONFIG = {
  maxRetries: 5,
  baseDelay: 10,
  maxDelay: 1000,
  jitter: true,
} satisfies Required<RetryConfig>;

export class RetryPolicy {
  readonly maxRetries: number;
  readonly baseDelay: number;
  readonly maxDelay: number;
  readonly jitter: boolean;
  #onRetry: ((attempt: number, delayMs: number, error: Error) => void) | null = null;
  #onBusy: ((attempt: number, delayMs: number) => void) | null = null;

  constructor(config?: RetryConfig) {
    const cfg = { ...DEFAULT_RETRY_CONFIG, ...config };
    this.maxRetries = cfg.maxRetries;
    this.baseDelay = cfg.baseDelay;
    this.maxDelay = cfg.maxDelay;
    this.jitter = cfg.jitter;
  }

  set onRetry(handler: ((attempt: number, delayMs: number, error: Error) => void) | null) {
    this.#onRetry = handler;
  }

  set onBusy(handler: ((attempt: number, delayMs: number) => void) | null) {
    this.#onBusy = handler;
  }

  getDelay(attempt: number): number {
    const delay = Math.min(
      this.baseDelay * Math.pow(2, attempt),
      this.maxDelay,
    );
    if (!this.jitter) return delay;
    return Math.floor(delay * (0.5 + Math.random() * 0.5));
  }

  shouldRetry(attempt: number): boolean {
    return attempt < this.maxRetries;
  }

  isBusyError(error: unknown): boolean {
    if (error instanceof Error) {
      if ("errno" in error && typeof (error as Record<string, unknown>).errno === "number") {
        const errno = (error as Record<string, unknown>).errno as number;
        // SQLITE_BUSY = 5, SQLITE_BUSY_SNAPSHOT = 517
        return errno === 5 || errno === 517;
      }
      const msg = error.message.toLowerCase();
      return msg.includes("database is locked");
    }
    return false;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (!this.isBusyError(lastError)) {
          throw lastError;
        }

        if (!this.shouldRetry(attempt)) {
          this.#onBusy?.(attempt, 0);
          break;
        }

        const delay = this.getDelay(attempt);
        this.#onBusy?.(attempt, delay);
        this.#onRetry?.(attempt, delay, lastError);
        await Bun.sleep(delay);
      }
    }

    throw lastError ?? new Error("RetryPolicy: operation failed");
  }
}