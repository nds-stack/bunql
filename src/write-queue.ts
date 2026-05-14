/**
 * @module write-queue
 * @description FIFO async queue for serializing write operations.
 */
import Queue from "yocto-queue";
import { QueueError } from "./errors/queue-error.ts";

interface QueueItem<T = unknown> {
  execute: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

export class WriteQueue {
  #items = new Queue<QueueItem>();
  #processing = false;
  #closed = false;
  #drainPromise: Promise<void> | null = null;
  #drainResolve: (() => void) | null = null;
  #onDrain: (() => void) | null = null;
  #peakSize = 0;
  #totalEnqueued = 0;

  get size(): number {
    return this.#items.size;
  }

  get peakSize(): number {
    return this.#peakSize;
  }

  get totalEnqueued(): number {
    return this.#totalEnqueued;
  }

  get isProcessing(): boolean {
    return this.#processing;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  set onDrain(handler: (() => void) | null) {
    this.#onDrain = handler;
  }

  enqueue<T>(execute: () => Promise<T>): Promise<T> {
    if (this.#closed) {
      return Promise.reject(
        new QueueError("WriteQueue is closed. Cannot enqueue new operations."),
      );
    }

    return new Promise<T>((resolve, reject) => {
      this.#items.enqueue({ execute, resolve: resolve as (value: unknown) => void, reject });
      this.#totalEnqueued++;
      if (this.#items.size > this.#peakSize) {
        this.#peakSize = this.#items.size;
      }
      if (!this.#processing) {
        this.#processing = true;
        queueMicrotask(() => this.#process());
      }
    });
  }

  async drain(): Promise<void> {
    if (this.#items.size === 0 && !this.#processing) {
      return;
    }
    if (!this.#drainPromise) {
      this.#drainPromise = new Promise((resolve) => {
        this.#drainResolve = resolve;
      });
    }
    return this.#drainPromise;
  }

  close(): void {
    this.#closed = true;
  }

  clearPending(reason: string): void {
    const error = new QueueError(reason);
    while (this.#items.size > 0) {
      const item = this.#items.dequeue();
      if (item) {
        item.reject(error);
      }
    }
  }

  async #process(): Promise<void> {
    try {
      while (this.#items.size > 0) {
        const item = this.#items.dequeue();
        if (!item) continue;

        try {
          const result = await item.execute();
          item.resolve(result);
        } catch (error) {
          item.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    } finally {
      this.#processing = false;
      this.#drainResolve?.();
      this.#drainPromise = null;
      this.#drainResolve = null;
      this.#onDrain?.();
    }
  }
}