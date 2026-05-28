/**
 * @module driver-error
 * @description Error thrown when a database driver fails.
 */
export class DriverError extends Error {
  constructor(message: string, cause?: Error) {
    super(message, { cause });
    this.name = "DriverError";
  }
}
