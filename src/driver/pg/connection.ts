/**
 * @module driver/pg/connection
 * @description TCP connection + pool for PostgreSQL — custom implementation via Bun.connect().
 */

import { PGReader, encodeStartup, encodePassword, encodeMD5Password, encodeQuery, encodeTerminate, md5Hex, type PGMessage } from "./wire";

export interface PGConnectionConfig {
  hostname: string;
  port: number;
  db: string;
  user?: string;
  password?: string;
  maxPoolSize?: number;
  connectionTimeoutMs?: number;
}

interface SocketHandle {
  write(data: Uint8Array): boolean;
  end(): void;
}

export class PGConnection {
  readonly config: PGConnectionConfig;
  #socket: SocketHandle | null = null;
  #buffer = new Uint8Array(0);
  #pendingResolve: ((data: Uint8Array) => void) | null = null;
  #pendingReject: ((err: Error) => void) | null = null;
  #pendingSize = 0;
  #closed = false;

  constructor(config: PGConnectionConfig) {
    this.config = config;
  }

  get connected(): boolean {
    return this.#socket !== null && !this.#closed;
  }

  async connect(): Promise<void> {
    if (this.#socket) return;

    const self = this;
    this.#socket = await Bun.connect({
      hostname: this.config.hostname,
      port: this.config.port,
      socket: {
        data(socket: unknown, data: Uint8Array) { self.#onData(data); },
        error(socket: unknown, err: Error) { self.#onError(err); },
        close(socket: unknown) { self.#onClose(); },
        drain(socket: unknown) {},
      },
    }) as unknown as SocketHandle;

    const startup = encodeStartup({
      user: this.config.user ?? "postgres",
      database: this.config.db,
    });
    this.#socket.write(startup);

    await this.#auth();
  }

  async #auth(): Promise<void> {
    const reader = new PGReader(new Uint8Array(0));

    for (let attempts = 0; attempts < 100; attempts++) {
      const raw = await this.#readBuffer();
      const newReader = new PGReader(concat([reader.buffer.subarray(reader.offset), raw]));
      reader.buffer.set(newReader.buffer);
      reader.offset = 0;

      while (reader.hasMessage()) {
        const msg = reader.readMessage()!;

        switch (msg.type) {
          case "AuthenticationOk":
            return;

          case "AuthenticationCleartextPassword": {
            if (!this.config.password) throw new PGError("Password required");
            this.#socket!.write(encodePassword(this.config.password));
            continue;
          }

          case "AuthenticationMD5Password": {
            if (!this.config.password) throw new PGError("Password required");
            const user = this.config.user ?? "postgres";
            this.#socket!.write(encodeMD5Password(this.config.password, user, msg.salt));
            continue;
          }

          case "ErrorResponse":
            throw new PGError(`Auth failed: ${msg.message}`);

          case "ReadyForQuery":
            return;

          default:
            continue;
        }
      }
    }
    throw new PGError("Auth timeout");
  }

  async #readBuffer(): Promise<Uint8Array> {
    if (this.#buffer.length > 0) {
      const data = this.#buffer;
      this.#buffer = new Uint8Array(0);
      return data;
    }

    return new Promise<Uint8Array>((resolve, reject) => {
      this.#pendingResolve = resolve;
      this.#pendingReject = reject;
    });
  }

  async query(sql: string): Promise<PGQueryResult> {
    if (!this.#socket || this.#closed) throw new Error("Connection closed");

    this.#socket.write(encodeQuery(sql));

    const columns: PGColumn[] = [];
    const rows: (Uint8Array | null)[][] = [];
    let commandTag = "";
    let error: PGError | null = null;

    for (let attempts = 0; attempts < 10000; attempts++) {
      const raw = await this.#readBuffer();
      const reader = new PGReader(raw);

      while (reader.hasMessage()) {
        const msg = reader.readMessage()!;

        switch (msg.type) {
          case "RowDescription":
            columns.push(...msg.columns);
            break;

          case "DataRow":
            rows.push(msg.values);
            break;

          case "CommandComplete":
            commandTag = msg.tag;
            break;

          case "ReadyForQuery":
            if (error) throw error;
            return { columns: columns.map((c) => c.name), rows: rowsToObjects(columns, rows), commandTag };

          case "ErrorResponse":
            error = new PGError(msg.message, msg.code);
            break;

          case "NoticeResponse":
            break;

          default:
            break;
        }
      }

      if (reader.available > 0) {
        this.#buffer = new Uint8Array(reader.buffer.subarray(reader.offset));
      }
    }
    throw new PGError("Query timeout");
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#pendingReject) {
      this.#pendingReject(new Error("Connection closed"));
      this.#pendingResolve = null;
      this.#pendingReject = null;
    }
    if (this.#socket) {
      try { this.#socket.write(encodeTerminate()); } catch {}
      this.#socket.end();
      this.#socket = null;
    }
  }

  #onData(data: Uint8Array): void {
    if (this.#pendingResolve) {
      const resolve = this.#pendingResolve;
      this.#pendingResolve = null;
      resolve(data);
    } else {
      const newBuf = new Uint8Array(this.#buffer.length + data.length);
      newBuf.set(this.#buffer);
      newBuf.set(data, this.#buffer.length);
      this.#buffer = newBuf;
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
}

export interface PGQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  commandTag: string;
}

export interface PGColumn {
  name: string;
}

export class PGConnectionPool {
  readonly config: PGConnectionConfig;
  #connections: PGConnection[] = [];
  #maxSize: number;
  #active = 0;
  #poolTimeoutMs: number;

  constructor(config: PGConnectionConfig) {
    this.config = config;
    this.#maxSize = config.maxPoolSize ?? 5;
    this.#poolTimeoutMs = config.connectionTimeoutMs ?? 30000;
  }

  get totalConnections(): number {
    return this.#connections.length + this.#active;
  }

  async acquire(): Promise<PGConnection> {
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
        const conn = new PGConnection(this.config);
        await conn.connect();
        this.#active++;
        return conn;
      }

      await Bun.sleep(10);
    }

    throw new PGError(`Connection pool exhausted: timed out after ${this.#poolTimeoutMs}ms`);
  }

  release(conn: PGConnection): void {
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

export class PGError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "PGError";
    this.code = code;
  }
}

function rowsToObjects(columns: PGColumn[], rows: (Uint8Array | null)[][]): Record<string, unknown>[] {
  const textDecoder = new TextDecoder();
  return rows.map((row) => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < columns.length && i < row.length; i++) {
      const val = row[i];
      obj[columns[i]!.name] = val === null ? null : textDecoder.decode(val);
    }
    return obj;
  });
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export type { };
