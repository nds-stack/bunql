/**
 * @module driver-error
 * @description Error thrown when a database driver fails.
 */
import { BunQLError } from "./bunql-error.ts";

export class DriverError extends BunQLError {
  constructor(message: string, cause?: Error) {
    super(message, { cause });
    this.name = "DriverError";
  }
}
