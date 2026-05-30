import { DriverError } from "../../errors/driver-error.ts";

export class MongoError extends DriverError {
  readonly code: number;
  readonly response: Record<string, unknown>;
  constructor(message: string, code?: number, response?: Record<string, unknown>) {
    super(message);
    this.name = "MongoError";
    this.code = code ?? -1;
    this.response = response ?? {};
  }
}
