/**
 * @module driver/pg/wire
 * @description PostgreSQL wire protocol (v3.0) — message encoder/decoder, zero deps.
 * Note: PG uses BIG-ENDIAN (network byte order) for all integer fields.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
import { md5 } from "./md5";

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
  | { type: "ParseComplete" }
  | { type: "BindComplete" }
  | { type: "ParameterDescription"; paramTypes: number[] }
  | { type: "NoData" }
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

function be16(value: number): Uint8Array {
  const buf = new Uint8Array(2);
  new DataView(buf.buffer).setInt16(0, value, false);
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

// ─── Extended Query Protocol ──────────────────────────

export function encodeParse(name: string, sql: string, paramTypes?: number[]): Uint8Array {
  const nameBytes = textEncoder.encode(name + "\0");
  const sqlBytes = textEncoder.encode(sql + "\0");
  const _numParams = be32(0);
  const paramTypeBytes = paramTypes ? concat(paramTypes.map(be32)) : new Uint8Array(0);
  const body = concat([nameBytes, sqlBytes, be16(paramTypes?.length ?? 0), paramTypeBytes]);
  const len = be32(4 + body.length);
  return encodeMessage("P", concat([len, body]));
}

export function encodeBind(portal: string, stmt: string, params: (Uint8Array | null)[]): Uint8Array {
  const portalBytes = textEncoder.encode(portal + "\0");
  const stmtBytes = textEncoder.encode(stmt + "\0");
  // All param format codes = 0 (text) — zero-length list implies text format for all
  const paramFmts = be16(0);
  const numParams = be16(params.length);
  const paramData = concat(params.map((p) => p ? concat([be32(p.length), p]) : be32(-1)));
  // All result format codes = 0 (text)
  const resultFmts = be16(0);
  const body = concat([portalBytes, stmtBytes, paramFmts, numParams, paramData, resultFmts]);
  const len = be32(4 + body.length);
  return encodeMessage("B", concat([len, body]));
}

export function encodeDescribe(type: "P" | "S", name: string): Uint8Array {
  const body = concat([new Uint8Array([type === "P" ? 80 : 83]), textEncoder.encode(name + "\0")]);
  const len = be32(4 + body.length);
  return encodeMessage("D", concat([len, body]));
}

export function encodeExecute(portal: string, maxRows: number): Uint8Array {
  const body = concat([textEncoder.encode(portal + "\0"), be32(maxRows)]);
  const len = be32(4 + body.length);
  return encodeMessage("E", concat([len, body]));
}

export function encodeSync(): Uint8Array {
  return encodeMessage("S", be32(4));
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
      case "1": return { type: "ParseComplete" };
      case "2": return { type: "BindComplete" };
      case "t": return this.#parseParamDesc(body);
      case "n": return { type: "NoData" };
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

  #parseParamDesc(body: Uint8Array): PGMessage {
    const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const count = v.getInt16(0, false);
    const types: number[] = [];
    for (let i = 0; i < count; i++) {
      types.push(v.getInt32(2 + i * 4, false));
    }
    return { type: "ParameterDescription", paramTypes: types };
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

export type { };
