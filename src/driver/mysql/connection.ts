import { MySQLError } from "./error";

/**
 * @module driver/mysql/connection
 * @description TCP connection + pool for MySQL — custom implementation via Bun.connect().
 */

import {
  parseHandshake, encodeHandshakeResponse, encodeQueryPacket, encodeStmtPrepare, encodeStmtExecute, encodeStmtClose, assemblePackets, parseResponse, parsePrepareOK, concatBytes,
  type HandshakePacket, type ResponsePacket, type ResultSetPacket, type PrepareOKPacket,
} from "./wire";

export interface MySQLConnectionConfig {
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

export class MySQLConnection {
  readonly config: MySQLConnectionConfig;
  #socket: SocketHandle | null = null;
  #buffer = new Uint8Array(0);
  #pendingResolve: ((data: Uint8Array) => void) | null = null;
  #pendingReject: ((err: Error) => void) | null = null;
  #seq = 0;
  #closed = false;

  constructor(config: MySQLConnectionConfig) {
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

    // Receive handshake
    const raw = await this.#readBuffer();
    const packets = assemblePackets(raw);
    if (packets.length === 0) throw new MySQLError("No handshake packet");
    const handshake = parseHandshake(packets[0]!);

    // Error during handshake?
    if (handshake.protocolVersion === 0xff) {
      const err = parseResponse(packets);
      if (err.type === "error") throw new MySQLError(err.message, err.code);
      throw new MySQLError("Handshake failed");
    }

    // Send auth response
    const authResp = encodeHandshakeResponse({
      user: this.config.user ?? "root",
      password: this.config.password ?? "",
      database: this.config.db,
    }, handshake);
    this.#socket.write(authResp);

    // Read auth response
    const authRaw = await this.#readBuffer();
    const authPackets = assemblePackets(authRaw);
    if (authPackets.length === 0) throw new MySQLError("No auth response");

    const authResp2 = parseResponse(authPackets);
    if (authResp2.type === "error") {
      throw new MySQLError(authResp2.message, authResp2.code);
    }
  }

  async query(sql: string): Promise<ResponsePacket> {
    if (!this.#socket || this.#closed) throw new Error("Connection closed");
    this.#seq = 0;
    const queryPacket = encodeQueryPacket(this.#seq++, sql);
    this.#socket.write(queryPacket);
    const allData = await this.#readBuffer();
    const packets = assemblePackets(allData);
    if (packets.length === 0) throw new MySQLError("Empty response");
    return parseResponse(packets);
  }

  async begin(): Promise<ResponsePacket> { return this.query("START TRANSACTION"); }
  async commit(): Promise<ResponsePacket> { return this.query("COMMIT"); }
  async rollback(): Promise<ResponsePacket> { return this.query("ROLLBACK"); }
  async savepoint(name: string): Promise<ResponsePacket> { return this.query(`SAVEPOINT ${name}`); }
  async releaseSavepoint(name: string): Promise<ResponsePacket> { return this.query(`RELEASE SAVEPOINT ${name}`); }
  async rollbackTo(name: string): Promise<ResponsePacket> { return this.query(`ROLLBACK TO SAVEPOINT ${name}`); }

  async prepare(sql: string): Promise<PrepareOKPacket> {
    if (!this.#socket || this.#closed) throw new Error("Connection closed");
    this.#seq = 0;
    const packet = encodeStmtPrepare(this.#seq++, sql);
    this.#socket.write(packet);

    const raw = await this.#readBuffer();
    const packets = assemblePackets(raw);
    if (packets.length === 0) throw new MySQLError("Empty prepare response");
    const info = parsePrepareOK(packets[0]!, packets);

    const totalPackets = 1 + info.columnCount + info.paramCount;
    while (packets.length < totalPackets) {
      const more = await this.#readBuffer();
      const morePackets = assemblePackets(more);
      packets.push(...morePackets);
    }

    return info;
  }

  async executePrepared(stmtId: number, params: (Uint8Array | null)[], paramTypes?: number[]): Promise<ResponsePacket> {
    if (!this.#socket || this.#closed) throw new Error("Connection closed");
    this.#seq = 0;
    const packet = encodeStmtExecute(this.#seq++, stmtId, params, paramTypes);
    this.#socket.write(packet);
    const raw = await this.#readBuffer();
    const packets = assemblePackets(raw);
    if (packets.length === 0) throw new MySQLError("Empty execute response");
    return parseResponse(packets, true); // COM_STMT_EXECUTE = binary protocol
  }

  async closeStmt(stmtId: number): Promise<void> {
    if (!this.#socket) return;
    const packet = encodeStmtClose(0, stmtId);
    this.#socket.write(packet);
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
}





