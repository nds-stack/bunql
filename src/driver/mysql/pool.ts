import { MySQLConnection } from "./connection";
import type { MySQLConnectionConfig } from "./connection";
import { MySQLError } from "./error";

export class MySQLConnectionPool {
  readonly config: MySQLConnectionConfig;
  #connections: MySQLConnection[] = [];
  #maxSize: number;
  #active = 0;
  #poolTimeoutMs: number;

  constructor(config: MySQLConnectionConfig) {
    this.config = config;
    this.#maxSize = config.maxPoolSize ?? 5;
    this.#poolTimeoutMs = config.connectionTimeoutMs ?? 30000;
  }

  get totalConnections(): number { return this.#connections.length + this.#active; }

  async acquire(): Promise<MySQLConnection> {
    const deadline = Date.now() + this.#poolTimeoutMs;
    while (Date.now() < deadline) {
      while (this.#connections.length > 0) {
        const conn = this.#connections.pop()!;
        if (conn.connected) { this.#active++; return conn; }
        conn.close();
      }
      if (this.totalConnections < this.#maxSize) {
        const conn = new MySQLConnection(this.config);
        await conn.connect();
        this.#active++;
        return conn;
      }
      await Bun.sleep(10);
    }
    throw new MySQLError(`Connection pool exhausted: timed out after ${this.#poolTimeoutMs}ms`);
  }

  release(conn: MySQLConnection): void {
    this.#active--;
    if (conn.connected) this.#connections.push(conn);
  }

  async closeAll(): Promise<void> {
    await Promise.all(this.#connections.map((c) => c.close()));
    this.#connections = []; this.#active = 0;
  }
}
