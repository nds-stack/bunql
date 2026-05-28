/**
 * @module driver/redis/connection
 * @description TCP connection + pool for Redis — custom implementation via Bun.connect().
 */

import { encodeCommand, decodeSimple, type RESPValue, RESPReader } from "./resp";

export interface RedisConnectionConfig {
  hostname: string;
  port: number;
  db?: number;
  username?: string;
  password?: string;
  maxPoolSize?: number;
  connectionTimeoutMs?: number;
}

interface SocketHandle {
  write(data: Uint8Array): boolean;
  end(): void;
}

export class RedisConnection {
  readonly config: RedisConnectionConfig;
  #socket: SocketHandle | null = null;
  #buffer = new Uint8Array(0);
  #pendingResolve: ((data: Uint8Array) => void) | null = null;
  #pendingReject: ((err: Error) => void) | null = null;
  #closed = false;
  #authenticated = false;

  constructor(config: RedisConnectionConfig) {
    this.config = config;
  }

  get connected(): boolean {
    return this.#socket !== null && !this.#closed;
  }

  async connect(): Promise<void> {
    if (this.#socket) return;

    const self = this;
    const socket = await Bun.connect({
      hostname: this.config.hostname,
      port: this.config.port,
      socket: {
        data(socket: unknown, data: Uint8Array) { self.#onData(data); },
        error(socket: unknown, err: Error) { self.#onError(err); },
        close(socket: unknown) { self.#onClose(); },
        drain(socket: unknown) {},
      },
    });

    this.#socket = socket as unknown as SocketHandle;

    if (this.config.password) {
      const authResp = await this.#sendCommand(["AUTH", this.config.password]);
      if (authResp.type === "error") {
        throw new RedisError(`AUTH failed: ${authResp.value}`);
      }
    }

    if (this.config.db !== undefined && this.config.db > 0) {
      const selectResp = await this.#sendCommand(["SELECT", String(this.config.db)]);
      if (selectResp.type === "error") {
        throw new RedisError(`SELECT failed: ${selectResp.value}`);
      }
    }

    this.#authenticated = true;
  }

  async #sendCommand(args: string[]): Promise<RESPValue> {
    if (!this.#socket || this.#closed) {
      throw new Error("Connection closed");
    }

    const data = encodeCommand(args[0]!, args.slice(1));
    this.#socket.write(data);

    const raw = await this.#readResponse();
    const val = decodeSimple(raw);
    return val;
  }

  async sendCommand(args: string[]): Promise<RESPValue> {
    if (!this.#authenticated && this.config.password) {
      throw new Error("Not authenticated");
    }
    return this.#sendCommand(args);
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#pendingReject) {
      this.#pendingReject(new Error("Connection closed"));
      this.#pendingResolve = null;
      this.#pendingReject = null;
    }
    if (this.#socket) {
      this.#socket.end();
      this.#socket = null;
    }
  }

  #onData(data: Uint8Array): void {
    const newBuf = new Uint8Array(this.#buffer.length + data.length);
    newBuf.set(this.#buffer);
    newBuf.set(data, this.#buffer.length);
    this.#buffer = newBuf;

    if (this.#pendingResolve) {
      this.#tryResolvePending();
    }
  }

  #tryResolvePending(): void {
    if (!this.#pendingResolve) return;

    const reader = new RESPReader(this.#buffer);
    try {
      reader.readValue();
      if (reader.offset === 0) return;

      const result = this.#buffer.subarray(0, reader.offset);
      this.#buffer = this.#buffer.subarray(reader.offset);
      const resolve = this.#pendingResolve;
      this.#pendingResolve = null;
      resolve(result);
    } catch {
      return;
    }
  }

  #onError(err: Error): void {
    this.#closed = true;
    if (this.#pendingReject) {
      this.#pendingReject(err);
      this.#pendingResolve = null;
      this.#pendingReject = null;
    }
  }

  #onClose(): void {
    this.#closed = true;
    this.#socket = null;
    if (this.#pendingReject) {
      this.#pendingReject(new Error("Connection closed"));
      this.#pendingResolve = null;
      this.#pendingReject = null;
    }
  }

  async #readResponse(): Promise<Uint8Array> {
    if (this.#buffer.length > 0) {
      const reader = new RESPReader(this.#buffer);
      try {
        reader.readValue();
        if (reader.offset > 0) {
          const result = this.#buffer.subarray(0, reader.offset);
          this.#buffer = this.#buffer.subarray(reader.offset);
          return result;
        }
      } catch {
        // incomplete, need more data
      }
    }

    return new Promise<Uint8Array>((resolve, reject) => {
      this.#pendingResolve = resolve;
      this.#pendingReject = reject;
    });
  }
}

export class RedisConnectionPool {
  readonly config: RedisConnectionConfig;
  #connections: RedisConnection[] = [];
  #maxSize: number;
  #active = 0;
  #poolTimeoutMs: number;

  constructor(config: RedisConnectionConfig) {
    this.config = config;
    this.#maxSize = config.maxPoolSize ?? 10;
    this.#poolTimeoutMs = config.connectionTimeoutMs ?? 30000;
  }

  get totalConnections(): number {
    return this.#connections.length + this.#active;
  }

  async acquire(): Promise<RedisConnection> {
    const deadline = Date.now() + this.#poolTimeoutMs;

    while (Date.now() < deadline) {
      while (this.#connections.length > 0) {
        const conn = this.#connections.pop()!;
        if (conn.connected) {
          this.#active++;
          return conn;
        }
        conn.close();
      }

      if (this.totalConnections < this.#maxSize) {
        const conn = new RedisConnection(this.config);
        await conn.connect();
        this.#active++;
        return conn;
      }

      await Bun.sleep(10);
    }

    throw new RedisError(`Connection pool exhausted: timed out after ${this.#poolTimeoutMs}ms`);
  }

  release(conn: RedisConnection): void {
    this.#active--;
    if (conn.connected) {
      this.#connections.push(conn);
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all(this.#connections.map((c) => c.close()));
    this.#connections = [];
    this.#active = 0;
  }
}

export class RedisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedisError";
  }
}

export type { };
