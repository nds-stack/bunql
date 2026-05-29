import { RedisError } from "./error";

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
  #inTransaction = false;
  #txQueue: string[][] = [];

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
        data(_socket: unknown, data: Uint8Array) { self.#onData(data); },
        error(_socket: unknown, err: Error) { self.#onError(err); },
        close(_socket: unknown) { self.#onClose(); },
        drain(_socket: unknown) {},
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
    if (this.#inTransaction) {
      this.#txQueue.push(args);
      return { type: "simple-string", value: "QUEUED" };
    }
    return this.#sendCommand(args);
  }

  async multi(): Promise<void> {
    await this.#sendCommand(["MULTI"]);
    this.#inTransaction = true;
    this.#txQueue = [];
  }

  async exec(): Promise<RESPValue[]> {
    if (!this.#inTransaction) throw new Error("Not in transaction");
    this.#inTransaction = false;
    const _queue = this.#txQueue;
    this.#txQueue = [];

    // Send EXEC command
    const execData = encodeCommand("EXEC", []);
    this.#socket!.write(execData);
    const raw = await this.#readResponse();
    const val = decodeSimple(raw);

    if (val.type === "error") throw new RedisError(`EXEC failed: ${val.value}`);
    if (val.type === "array" && val.value) {
      return val.value;
    }
    return [];
  }

  async discard(): Promise<void> {
    if (!this.#inTransaction) throw new Error("Not in transaction");
    this.#inTransaction = false;
    this.#txQueue = [];
    const resp = await this.#sendCommand(["DISCARD"]);
    if (resp.type === "error") throw new RedisError(`DISCARD failed: ${resp.value}`);
  }

  get inTransaction(): boolean {
    return this.#inTransaction;
  }

  // TransactionBackend interface
  async begin(): Promise<void> { await this.multi(); }
  async commit(): Promise<void> { await this.exec(); }
  async savepoint(_name: string): Promise<void> { /* Redis does not support savepoints */ }
  async releaseSavepoint(_name: string): Promise<void> { /* no-op */ }
  async rollbackTo(_name: string): Promise<void> { await this.discard(); }

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
    } catch (err) {
      const reject = this.#pendingReject;
      this.#pendingResolve = null;
      this.#pendingReject = null;
      this.#buffer = new Uint8Array(0);
      reject?.(err instanceof Error ? err : new Error(String(err)));
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





