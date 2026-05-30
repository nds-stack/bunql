import { DriverError } from "../../errors/driver-error.ts";

export class PGError extends DriverError {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "PGError";
    this.code = code;
  }
}
