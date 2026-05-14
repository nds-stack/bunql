/**
 * @module connection-error
 * @description Error thrown on database connection or close failures.
 */
import { BunQLError } from "./bunql-error.ts";

export class ConnectionError extends BunQLError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConnectionError";
  }
}