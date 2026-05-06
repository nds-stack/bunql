import { BunQLError } from "./bunql-error.ts";

export class TransactionError extends BunQLError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TransactionError";
  }
}