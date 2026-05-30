import { DriverError } from "../../errors/driver-error.ts";

export class RedisError extends DriverError {
  constructor(message: string) {
    super(message);
    this.name = "RedisError";
  }
}
