import { DriverError } from "../../errors/driver-error.ts";

export class MySQLError extends DriverError {
  readonly code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "MySQLError";
    this.code = code;
  }
}
