/**
 * @module driver/mongodb/connection
 * @description TCP connection + pool for MongoDB — custom implementation via Bun.connect().
 */

import { buildCommand, parseResponse, readHeader } from "./wire-protocol";
import { performScramSha256 } from "./auth-scram";

export interface MongoConnectionConfig {
  hostname: string;
  port: number;
  db: string;
  username?: string;
  password?: string;
  authDb?: string;
  maxPoolSize?: number;
  connectionTimeoutMs?: number;
}

interface SocketHandle {
  write(data: Uint8Array): boolean;
  end(): void;
}

export class MongoConnection {
  readonly config: MongoConnectionConfig;
  #socket: SocketHandle | null = null;
  #buffer = new Uint8Array(0);
  #pendingResolve: ((data: Uint8Array) => void) | null = null;
  #pendingReject: ((err: Error) => void) | null = null;
  #pendingSize = 0;
  #closed = false;
  #authenticated = false;
  #requestId = 1;

  constructor(config: MongoConnectionConfig) {
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
        data(socket: unknown, data: Uint8Array) {
          self.#onData(data);
        },
        error(socket: unknown, err: Error) {
          self.#onError(err);
        },
        close(socket: unknown) {
          self.#onClose();
        },
        drain(socket: unknown) {},
      },
    });

    this.#socket = socket as unknown as SocketHandle;

    if (this.config.username && this.config.password) {
      await performScramSha256(
        (cmd) => this.execute("admin", cmd),
        this.config.username,
        this.config.password,
      );
    }

    this.#authenticated = true;
  }

  async execute(db: string, command: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.#socket || this.#closed) {
      throw new Error("Connection closed");
    }

    const requestId = this.#requestId++;
    const data = buildCommand(db, command, requestId);
    this.#socket.write(data);

    const headerBytes = await this.#readBytes(16);
    const header = readHeader(headerBytes);

    if (header.messageLength < 16) {
      throw new MongoError(`Invalid message header: messageLength=${header.messageLength}`);
    }

    const bodyBytes = await this.#readBytes(header.messageLength - 16);

    const fullResponse = new Uint8Array(header.messageLength);
    fullResponse.set(headerBytes);
    fullResponse.set(bodyBytes, 16);

    const response = parseResponse(fullResponse);

    if (response.ok !== 1 && response.ok !== 1.0) {
      const errMsg = (response.errmsg as string) ?? (response.$err as string) ?? "Unknown error";
      const code = (response.code as number) ?? -1;
      throw new MongoError(errMsg, code, response);
    }

    return response;
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

    this.#tryResolvePending();
  }

  #tryResolvePending(): void {
    if (!this.#pendingResolve) return;
    if (this.#buffer.length < this.#pendingSize) return;

    const result = this.#buffer.subarray(0, this.#pendingSize);
    this.#buffer = this.#buffer.subarray(this.#pendingSize);
    const resolve = this.#pendingResolve;
    this.#pendingResolve = null;
    this.#pendingSize = 0;
    resolve(result);
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

  #readBytes(n: number): Promise<Uint8Array> {
    if (this.#buffer.length >= n) {
      const result = this.#buffer.subarray(0, n);
      this.#buffer = this.#buffer.subarray(n);
      return Promise.resolve(result);
    }

    return new Promise<Uint8Array>((resolve, reject) => {
      this.#pendingResolve = resolve;
      this.#pendingReject = reject;
      this.#pendingSize = n;
    });
  }
}

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

  get totalConnections(): number {
    return this.#connections.length + this.#active;
  }

  async acquire(): Promise<MongoConnection> {
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
        const conn = new MongoConnection(this.config);
        await conn.connect();
        this.#active++;
        return conn;
      }

      await Bun.sleep(10);
    }

    throw new MongoError(
      `Connection pool exhausted: timed out after ${this.#poolTimeoutMs}ms waiting for connection`,
      -2,
      {},
    );
  }

  release(conn: MongoConnection): void {
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

export type { };
