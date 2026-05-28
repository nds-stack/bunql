export class PGError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "PGError";
    this.code = code;
  }
}
