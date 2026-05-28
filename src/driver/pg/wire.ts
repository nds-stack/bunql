/**
 * @module driver/pg/wire
 * @description PostgreSQL wire protocol (v3.0) — message encoder/decoder, zero deps.
 * Note: PG uses BIG-ENDIAN (network byte order) for all integer fields.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const PROTOCOL_VERSION = 196608; // 3.0

export type PGMessage =
  | { type: "AuthenticationOk" }
  | { type: "AuthenticationCleartextPassword" }
  | { type: "AuthenticationMD5Password"; salt: Uint8Array }
  | { type: "AuthenticationKerberosV5" }
  | { type: "AuthenticationSCMCredential" }
  | { type: "AuthenticationGSS" }
  | { type: "AuthenticationSSPI" }
  | { type: "AuthenticationGSSContinue"; data: Uint8Array }
  | { type: "BackendKeyData"; pid: number; key: number }
  | { type: "ParameterStatus"; name: string; value: string }
  | { type: "ReadyForQuery"; status: "idle" | "transaction" | "error" }
  | { type: "RowDescription"; columns: PGColumn[] }
  | { type: "DataRow"; values: (Uint8Array | null)[] }
  | { type: "CommandComplete"; tag: string }
  | { type: "ErrorResponse"; severity: string; code: string; message: string }
  | { type: "NoticeResponse"; message: string }
  | { type: "EmptyQueryResponse" }
  | { type: "Unknown"; raw: Uint8Array };

export interface PGColumn {
  name: string;
  tableOID: number;
  columnAttr: number;
  typeOID: number;
  typeSize: number;
  typeMod: number;
  format: number;
}

function be32(value: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setInt32(0, value, false);
  return buf;
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

function splitCstrings(data: Uint8Array): string[] {
  const parts: string[] = [];
  let off = 0;
  while (off < data.length) {
    const end = data.indexOf(0, off);
    if (end === -1) break;
    parts.push(textDecoder.decode(data.subarray(off, end)));
    off = end + 1;
  }
  return parts;
}

// ─── Encoders (all big-endian) ────────────────────────

export function encodeStartup(params: Record<string, string>): Uint8Array {
  const pairs: Uint8Array[] = [];
  for (const [k, v] of Object.entries(params)) {
    pairs.push(textEncoder.encode(k + "\0" + v + "\0"));
  }
  const body = concat(pairs);
  const terminator = new Uint8Array([0]);
  const payload = concat([be32(PROTOCOL_VERSION), body, terminator]);
  const len = be32(4 + payload.length);
  return concat([len, payload]);
}

export function encodePassword(password: string): Uint8Array {
  const payload = textEncoder.encode(password + "\0");
  const len = be32(4 + payload.length);
  return encodeMessage("p", concat([len, payload]));
}

export function encodeMD5Password(password: string, user: string, salt: Uint8Array): Uint8Array {
  const inner = md5(password + user);
  const hash = md5(inner + bytesToHex(salt));
  const finalStr = "md5" + hash;
  const payload = textEncoder.encode(finalStr + "\0");
  const len = be32(4 + payload.length);
  return encodeMessage("p", concat([len, payload]));
}

export function encodeQuery(sql: string): Uint8Array {
  const payload = textEncoder.encode(sql + "\0");
  const len = be32(4 + payload.length);
  return encodeMessage("Q", concat([len, payload]));
}

export function encodeTerminate(): Uint8Array {
  const len = be32(4);
  return encodeMessage("X", len);
}

function encodeMessage(type: string, body: Uint8Array): Uint8Array {
  return concat([textEncoder.encode(type), body]);
}

// ─── Reader (all big-endian) ──────────────────────────

export class PGReader {
  readonly buffer: Uint8Array;
  readonly view: DataView;
  offset = 0;

  constructor(buffer: Uint8Array) {
    this.buffer = buffer;
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  get available(): number {
    return this.buffer.length - this.offset;
  }

  hasMessage(): boolean {
    if (this.available < 5) return false;
    const len = this.view.getInt32(this.offset + 1, false);
    return this.available >= 1 + len;
  }

  readMessage(): PGMessage | null {
    if (this.available < 5) return null;
    const type = String.fromCharCode(this.buffer[this.offset]!);
    const len = this.view.getInt32(this.offset + 1, false);
    if (this.available < 1 + len) return null;

    const body = this.buffer.subarray(this.offset + 5, this.offset + 1 + len);
    this.offset += 1 + len;

    return this.#parseBody(type, body);
  }

  readAllMessages(): PGMessage[] {
    const msgs: PGMessage[] = [];
    while (this.hasMessage()) {
      const msg = this.readMessage();
      if (msg) msgs.push(msg);
    }
    return msgs;
  }

  #parseBody(type: string, body: Uint8Array): PGMessage {
    switch (type) {
      case "R": return this.#parseAuth(body);
      case "K": return this.#parseBackendKey(body);
      case "S": return this.#parseParamStatus(body);
      case "Z": return this.#parseReady(body);
      case "T": return this.#parseRowDesc(body);
      case "D": return this.#parseDataRow(body);
      case "C": return this.#parseCommandComplete(body);
      case "E": return this.#parseError(body);
      case "N": return this.#parseNotice(body);
      case "I": return { type: "EmptyQueryResponse" };
      default: return { type: "Unknown", raw: body };
    }
  }

  #parseAuth(body: Uint8Array): PGMessage {
    const v = new DataView(body.buffer, body.byteOffset, body.byteLength).getInt32(0, false);
    switch (v) {
      case 0: return { type: "AuthenticationOk" };
      case 3: return { type: "AuthenticationCleartextPassword" };
      case 5: return { type: "AuthenticationMD5Password", salt: body.subarray(4, 8) };
      case 2: return { type: "AuthenticationKerberosV5" };
      case 6: return { type: "AuthenticationSCMCredential" };
      case 7: return { type: "AuthenticationGSS" };
      case 8: return { type: "AuthenticationSSPI" };
      case 9: return { type: "AuthenticationGSSContinue", data: body.subarray(4) };
      default: return { type: "Unknown", raw: body };
    }
  }

  #parseBackendKey(body: Uint8Array): PGMessage {
    const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
    return { type: "BackendKeyData", pid: v.getInt32(0, false), key: v.getInt32(4, false) };
  }

  #parseParamStatus(body: Uint8Array): PGMessage {
    const parts = splitCstrings(body);
    return { type: "ParameterStatus", name: parts[0] ?? "", value: parts[1] ?? "" };
  }

  #parseReady(body: Uint8Array): PGMessage {
    const status = body[0]!;
    return {
      type: "ReadyForQuery",
      status: status === 73 ? "idle" : status === 84 ? "transaction" : "error",
    };
  }

  #parseRowDesc(body: Uint8Array): PGMessage {
    const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
    let off = 2;
    const numCols = v.getInt16(0, false);
    const columns: PGColumn[] = [];
    for (let i = 0; i < numCols; i++) {
      const end = body.indexOf(0, off);
      const name = textDecoder.decode(body.subarray(off, end));
      off = end + 1;
      const tableOID = v.getInt32(off, false); off += 4;
      const columnAttr = v.getInt16(off, false); off += 2;
      const typeOID = v.getInt32(off, false); off += 4;
      const typeSize = v.getInt16(off, false); off += 2;
      const typeMod = v.getInt32(off, false); off += 4;
      const format = v.getInt16(off, false); off += 2;
      columns.push({ name, tableOID, columnAttr, typeOID, typeSize, typeMod, format });
    }
    return { type: "RowDescription", columns };
  }

  #parseDataRow(body: Uint8Array): PGMessage {
    const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
    let off = 2;
    const numCols = v.getInt16(0, false);
    const values: (Uint8Array | null)[] = [];
    for (let i = 0; i < numCols; i++) {
      const colLen = v.getInt32(off, false); off += 4;
      if (colLen === -1) {
        values.push(null);
      } else {
        values.push(body.subarray(off, off + colLen));
        off += colLen;
      }
    }
    return { type: "DataRow", values };
  }

  #parseCommandComplete(body: Uint8Array): PGMessage {
    const end = body.indexOf(0);
    const tag = textDecoder.decode(body.subarray(0, end));
    return { type: "CommandComplete", tag };
  }

  #parseError(body: Uint8Array): PGMessage {
    const fields = splitCstrings(body);
    let severity = "", code = "", message = "";
    for (let i = 0; i < fields.length; i += 2) {
      const fieldType = fields[i]!;
      const fieldVal = fields[i + 1] ?? "";
      if (fieldType === "S") severity = fieldVal;
      else if (fieldType === "C") code = fieldVal;
      else if (fieldType === "M") message = fieldVal;
    }
    return { type: "ErrorResponse", severity, code, message };
  }

  #parseNotice(body: Uint8Array): PGMessage {
    const fields = splitCstrings(body);
    let message = "";
    for (let i = 0; i < fields.length; i += 2) {
      if (fields[i] === "M") message = fields[i + 1] ?? "";
    }
    return { type: "NoticeResponse", message };
  }
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

export function md5Hex(input: string): string {
  return md5(input);
}

// ─── Pure JS MD5 (RFC 1321) ───────────────────────────

function md5(str: string): string {
  const bytes = textEncoder.encode(str);
  const n = bytes.length;
  const padded = new Uint8Array((n + 72) & ~63);
  padded.set(bytes);
  padded[n] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, n << 3, true);

  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;

  for (let i = 0; i < padded.length; i += 64) {
    const w: number[] = [];
    for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4, true);
    let [A, B, C, D] = [a, b, c, d];

    for (let j = 0; j < 64; j++) {
      const idx = j < 16 ? j : j < 32 ? (5 * j + 1) % 16 : j < 48 ? (3 * j + 5) % 16 : (7 * j) % 16;
      const k = w[idx]!;
      const s = j < 16 ? [7, 12, 17, 22][j % 4]! : j < 32 ? [5, 9, 14, 20][j % 4]! : j < 48 ? [4, 11, 16, 23][j % 4]! : [6, 10, 15, 21][j % 4]!;
      let f: number;
      if (j < 16) f = (b & c) | (~b & d);
      else if (j < 32) f = (d & b) | (~d & c);
      else if (j < 48) f = b ^ c ^ d;
      else f = c ^ (b | ~d);
      const x = (a + f + k + K[j]!) >>> 0;
      const nb = (b + ((x << s) | (x >>> (32 - s)))) >>> 0;
      [a, b, c, d] = [d, nb, b, c];
    }

    a = (a + A) >>> 0;
    b = (b + B) >>> 0;
    c = (c + C) >>> 0;
    d = (d + D) >>> 0;
  }

  return hex(a) + hex(b) + hex(c) + hex(d);
}

const K = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
  0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
  0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
  0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
  0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
  0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
  0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
  0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
  0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];

function hex(n: number): string {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, n >>> 0, true);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type { };
