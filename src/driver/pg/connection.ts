import { PGError } from "./error";
import { rowsToObjects, concat } from "./helpers";

/**
 * @module driver/pg/connection
 * @description TCP connection + pool for PostgreSQL — custom implementation via Bun.connect().
 */

import { PGReader, encodeStartup, encodePassword, encodeMD5Password, encodeQuery, encodeParse, encodeBind, encodeDescribe, encodeExecute, encodeSync, encodeTerminate, type PGMessage, type PGColumn } from "./wire";

const textEncoder = new TextEncoder();

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
      const combined = concat([reader.buffer.subarray(reader.offset), raw]);
      const newReader = new PGReader(combined);

      while (newReader.hasMessage()) {
        const msg = newReader.readMessage()!;

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

      // Carry over unprocessed data
      if (newReader.available > 0) {
        const buf = new PGReader(new Uint8Array(newReader.buffer.subarray(newReader.offset)));
        Object.assign(reader, buf);
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

  async queryParams(sql: string, params: unknown[]): Promise<PGQueryResult> {
    if (!this.#socket || this.#closed) throw new Error("Connection closed");

    const stmtName = "";
    const portalName = "";

    // Convert params to text format
    const paramBytes: (Uint8Array | null)[] = params.map((p) => {
      if (p === null || p === undefined) return null;
      return textEncoder.encode(String(p));
    });

    // Pipeline: Parse + Describe + Bind + Execute + Sync
    const parseMsg = encodeParse(stmtName, sql);
    const descMsg = encodeDescribe("S", stmtName);
    const bindMsg = encodeBind(portalName, stmtName, paramBytes);
    const execMsg = encodeExecute(portalName, 0);
    const syncMsg = encodeSync();

    this.#socket.write(parseMsg);
    this.#socket.write(descMsg);
    this.#socket.write(bindMsg);
    this.#socket.write(execMsg);
    this.#socket.write(syncMsg);

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
          case "ParseComplete":
          case "BindComplete":
          case "ParameterDescription":
          case "NoData":
            break;

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

  async begin(): Promise<void> { await this.query("BEGIN"); }
  async commit(): Promise<void> { await this.query("COMMIT"); }
  async rollback(): Promise<void> { await this.query("ROLLBACK"); }
  async savepoint(name: string): Promise<void> { await this.query(`SAVEPOINT "${name}"`); }
  async releaseSavepoint(name: string): Promise<void> { await this.query(`RELEASE SAVEPOINT "${name}"`); }
  async rollbackTo(name: string): Promise<void> { await this.query(`ROLLBACK TO SAVEPOINT "${name}"`); }

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






