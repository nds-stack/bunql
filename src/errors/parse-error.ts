/**
 * @module parse-error
 * @description Error thrown when SQL or MQL parsing fails.
 */
export class ParseError extends Error {
  constructor(message: string, public pos: number) {
    super(`Parse error at position ${pos}: ${message}`);
    this.name = "ParseError";
  }
}
