export class BunQLError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BunQLError";
  }
}