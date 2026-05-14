/**
 * @module queue-error
 * @description Error thrown on WriteQueue operation failures.
 */
import { BunQLError } from "./bunql-error.ts";

export class QueueError extends BunQLError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "QueueError";
  }
}