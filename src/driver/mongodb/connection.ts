/**
 * @module driver/mongodb/connection
 * @description TCP connection + pool for MongoDB — custom implementation via Bun.connect().
 */

import { buildCommand, parseResponse, readHeader } from "./wire-protocol";
import { performScramSha256 } from "./auth-scram";
import { MongoError } from "./error";
import { ConnectionPool } from "./pool";
import { encodeBSON } from "./bson-encoder";

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
  #session: { id: Uint8Array; txnNumber: number } | null = null;

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

  // ─── Sessions & Transactions ──────────────────────────

  startSession(): void {
    const id = new Uint8Array(16);
    crypto.getRandomValues(id);
    this.#session = { id, txnNumber: 0 };
  }

  endSession(): void {
    this.#session = null;
  }

  get hasSession(): boolean {
    return this.#session !== null;
  }

  async executeWithSession(db: string, command: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.#session) return this.execute(db, command);
    const lsidDoc = encodeBSON({ id: this.#session.id });
    const cmd = { ...command, lsid: { $binary: { base64: btoa(String.fromCharCode(...this.#session.id)), subType: "04" } } };
    return this.execute(db, cmd);
  }

  async startTransaction(): Promise<void> {
    if (!this.#session) this.startSession();
    this.#session!.txnNumber++;
  }

  async commitTransaction(): Promise<Record<string, unknown>> {
    if (!this.#session) throw new MongoError("No active session");
    const lsidDoc = { id: { $binary: { base64: btoa(String.fromCharCode(...this.#session.id)), subType: "04" } } };
    return this.execute("admin", {
      commitTransaction: 1,
      lsid: lsidDoc,
      txnNumber: this.#session.txnNumber,
      autocommit: false,
    });
  }

  async abortTransaction(): Promise<Record<string, unknown>> {
    if (!this.#session) throw new MongoError("No active session");
    const lsidDoc = { id: { $binary: { base64: btoa(String.fromCharCode(...this.#session.id)), subType: "04" } } };
    return this.execute("admin", {
      abortTransaction: 1,
      lsid: lsidDoc,
      txnNumber: this.#session.txnNumber,
      autocommit: false,
    });
  }

  // TransactionBackend interface
  async begin(): Promise<void> { await this.startTransaction(); }
  async commit(): Promise<void> { await this.commitTransaction(); }
  async rollback(): Promise<void> { await this.abortTransaction(); }
  async savepoint(_name: string): Promise<void> { /* MongoDB does not support savepoints */ }
  async releaseSavepoint(_name: string): Promise<void> { /* no-op */ }
  async rollbackTo(_name: string): Promise<void> { /* no-op */ }

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

