/**
 * @module bunql-error
 * @description Base error class for all bunql errors.
 */
export class BunQLError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BunQLError";
  }
}