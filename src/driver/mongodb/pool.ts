import { MongoConnection } from "./connection";
import type { MongoConnectionConfig } from "./connection";
import { MongoError } from "./error";

export class ConnectionPool {
  readonly config: MongoConnectionConfig;
  #connections: MongoConnection[] = [];
  #maxSize: number;
  #active = 0;
  #poolTimeoutMs: number;

  constructor(config: MongoConnectionConfig) {
    this.config = config;
    this.#maxSize = config.maxPoolSize ?? 5;
    this.#poolTimeoutMs = config.connectionTimeoutMs ?? 30000;
  }

  get totalConnections(): number { return this.#connections.length + this.#active; }

  async acquire(): Promise<MongoConnection> {
    const deadline = Date.now() + this.#poolTimeoutMs;
    while (Date.now() < deadline) {
      while (this.#connections.length > 0) {
        const conn = this.#connections.pop()!;
        if (conn.connected) { this.#active++; return conn; }
        conn.close();
      }
      if (this.totalConnections < this.#maxSize) {
        const conn = new MongoConnection(this.config);
        await conn.connect();
        this.#active++;
        return conn;
      }
      await Bun.sleep(10);
    }
    throw new MongoError(`Connection pool exhausted: timed out after ${this.#poolTimeoutMs}ms`, -2, {});
  }

  release(conn: MongoConnection): void {
    this.#active--;
    if (conn.connected) this.#connections.push(conn);
  }

  async closeAll(): Promise<void> {
    await Promise.all(this.#connections.map((c) => c.close()));
    this.#connections = []; this.#active = 0;
  }
}
