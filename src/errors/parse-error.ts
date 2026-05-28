/**
 * @module parse-error
 * @description Error thrown when SQL or MQL parsing fails.
 */
import { BunQLError } from "./bunql-error.ts";

export class ParseError extends BunQLError {
  constructor(message: string, public pos: number) {
    super(`Parse error at position ${pos}: ${message}`);
    this.name = "ParseError";
  }
}
