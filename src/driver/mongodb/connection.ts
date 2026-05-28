/**
 * @module driver/mongodb/connection
 * @description TCP connection + pool for MongoDB — custom implementation via Bun.connect().
 */

import { buildCommand, parseResponse, readHeader } from "./wire-protocol";

export interface MongoConnectionConfig {
  hostname: string;
  port: number;
  db: string;
  username?: string;
  password?: string;
  authDb?: string;
  maxPoolSize?: number;
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
      await this.#authenticate(this.config.username, this.config.password);
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

    if (this.#pendingResolve) {
      const resolve = this.#pendingResolve;
      const reject = this.#pendingReject;
      this.#pendingResolve = null;
      this.#pendingReject = null;
      resolve(this.#buffer);
      this.#buffer = new Uint8Array(0);
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

  async #readBytes(n: number): Promise<Uint8Array> {
    if (this.#buffer.length >= n) {
      const result = this.#buffer.subarray(0, n);
      this.#buffer = this.#buffer.subarray(n);
      return result;
    }

    return new Promise<Uint8Array>((resolve, reject) => {
      this.#pendingResolve = resolve;
      this.#pendingReject = reject;
    });
  }

  async #authenticate(username: string, password: string): Promise<void> {
    const authDb = this.config.authDb ?? "admin";

    const clientNonce = generateNonce();
    const firstBare = `n=${escapeUsername(username)},r=${clientNonce}`;
    const clientFirst = `n,,${firstBare}`;

    const startResp = await this.execute(authDb, {
      saslStart: 1,
      mechanism: "SCRAM-SHA-256",
      payload: base64encode(textEncoder.encode(clientFirst)),
    });

    if (startResp.ok !== 1) {
      throw new MongoError("Failed to start authentication", (startResp.code as number) ?? -1, startResp);
    }

    const conversationId = startResp.conversationId as number;
    const payloadStr = base64decode(startResp.payload as string);

    const parts = payloadStr.split(",");
    const rVal = parts.find((p: string) => p.startsWith("r="));
    const sVal = parts.find((p: string) => p.startsWith("s="));
    const iVal = parts.find((p: string) => p.startsWith("i="));

    if (!rVal || !sVal || !iVal) {
      throw new MongoError("Invalid SCRAM response");
    }

    const serverNonce = rVal.substring(2);
    const salt = sVal.substring(2);
    const iterationCount = parseInt(iVal.substring(2), 10);

    if (!serverNonce.startsWith(clientNonce)) {
      throw new MongoError("Server nonce does not match client nonce");
    }

    const withoutProof = `c=biws,r=${serverNonce}`;
    const authMessage = `${firstBare},${payloadStr},${withoutProof}`;

    const saltedPassword = await hi(password, salt, iterationCount);

    const clientKey = await hmac(saltedPassword, textEncoder.encode("Client Key"));
    const storedKey = await sha256(clientKey);

    const clientSignature = await hmac(storedKey, textEncoder.encode(authMessage));
    const clientProof = xorBuffers(clientKey, clientSignature);

    const serverKey = await hmac(saltedPassword, textEncoder.encode("Server Key"));
    const serverSignature = await hmac(serverKey, textEncoder.encode(authMessage));

    const finalPayload = `${withoutProof},p=${base64encode(clientProof)}`;

    const finalResp = await this.execute(authDb, {
      saslContinue: 1,
      conversationId,
      payload: base64encode(textEncoder.encode(finalPayload)),
    });

    if (finalResp.ok !== 1) {
      throw new MongoError("Authentication failed", (finalResp.code as number) ?? -1, finalResp);
    }

    const finalPayloadStr = base64decode(finalResp.payload as string);
    const vParts = finalPayloadStr.split(",").filter((p: string) => p.startsWith("v="));
    if (vParts.length > 0) {
      const serverSig = base64decodeToBytes(vParts[0]!.substring(2));
      if (!buffersEqual(serverSig, serverSignature)) {
        throw new MongoError("Server signature does not match");
      }
    }
  }
}

export class ConnectionPool {
  readonly config: MongoConnectionConfig;
  #connections: MongoConnection[] = [];
  #maxSize: number;
  #active = 0;

  constructor(config: MongoConnectionConfig) {
    this.config = config;
    this.#maxSize = config.maxPoolSize ?? 5;
  }

  get totalConnections(): number {
    return this.#connections.length + this.#active;
  }

  async acquire(): Promise<MongoConnection> {
    while (this.#connections.length > 0) {
      const conn = this.#connections.pop()!;
      if (conn.connected) {
        this.#active++;
        return conn;
      }
    }

    if (this.totalConnections >= this.#maxSize) {
      await Bun.sleep(10);
      return this.acquire();
    }

    const conn = new MongoConnection(this.config);
    await conn.connect();
    this.#active++;
    return conn;
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

function generateNonce(length = 16): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  for (let i = 0; i < length; i++) {
    result += chars[array[i]! % chars.length];
  }
  return result;
}

function escapeUsername(user: string): string {
  return user.replace(/=/g, "=3D").replace(/,/g, "=2C");
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function base64encode(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]!);
  }
  return btoa(binary);
}

function base64decode(str: string): string {
  const bytes = base64decodeToBytes(str);
  return textDecoder.decode(bytes);
}

function base64decodeToBytes(str: string): Uint8Array {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function toBuf(src: Uint8Array): Uint8Array<ArrayBuffer> {
  const buf = new ArrayBuffer(src.length);
  const dst = new Uint8Array(buf);
  dst.set(src);
  return dst;
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest("SHA-256", toBuf(data));
  return new Uint8Array(hash);
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toBuf(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, toBuf(data));
  return new Uint8Array(signature);
}

async function hi(password: string, salt: string, iterations: number): Promise<Uint8Array> {
  const saltBytes = base64decodeToBytes(salt);
  const passwordBytes = textEncoder.encode(password);

  const initialBlock = new Uint8Array(saltBytes.length + 4);
  initialBlock.set(saltBytes);
  initialBlock[saltBytes.length] = 0;
  initialBlock[saltBytes.length + 1] = 0;
  initialBlock[saltBytes.length + 2] = 0;
  initialBlock[saltBytes.length + 3] = 1;

  let u = await hmac(passwordBytes, initialBlock);
  let result = new Uint8Array(u.buffer, u.byteOffset, u.byteLength);

  for (let i = 1; i < iterations; i++) {
    u = await hmac(passwordBytes, u);
    result = xorBuffers(result, u);
  }

  return result;
}

function xorBuffers(a: Uint8Array, b: Uint8Array): Uint8Array {
  const len = Math.min(a.length, b.length);
  const result = new Uint8Array(new ArrayBuffer(len));
  for (let i = 0; i < len; i++) {
    result[i] = a[i]! ^ b[i]!;
  }
  return result;
}

function buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export type { };
