/**
 * @module busy-error
 * @description Error thrown when SQLITE_BUSY retries are exhausted.
 */
import { BunQLError } from "./bunql-error.ts";

export class BusyError extends BunQLError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BusyError";
  }
}