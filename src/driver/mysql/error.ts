export class MySQLError extends Error {
  readonly code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "MySQLError";
    this.code = code;
  }
}
