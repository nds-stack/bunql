export class MongoError extends Error {
  readonly code: number;
  readonly response: Record<string, unknown>;
  constructor(message: string, code?: number, response?: Record<string, unknown>) {
    super(message);
    this.name = "MongoError";
    this.code = code ?? -1;
    this.response = response ?? {};
  }
}
