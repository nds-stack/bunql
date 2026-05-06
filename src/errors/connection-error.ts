import { BunQLError } from "./bunql-error.ts";

export class ConnectionError extends BunQLError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConnectionError";
  }
}