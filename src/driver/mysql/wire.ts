/**
 * @module driver/mysql/wire
 * @description MySQL wire protocol — packet framing, handshake, auth, COM_QUERY, zero deps.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const CLIENT_PROTOCOL_41 = 0x000200;
export const CLIENT_SECURE_CONNECTION = 0x00008000;
export const CLIENT_PLUGIN_AUTH = 0x00080000;
export const CLIENT_PLUGIN_AUTH_LENENC = 0x00200000;
export const CLIENT_DEPRECATE_EOF = 0x01000000;
export const CLIENT_CONNECT_WITH_DB = 0x00000008;

// ─── Packet framing ────────────────────────────────────

export function encodePacket(seq: number, payload: Uint8Array): Uint8Array {
  const len = payload.length;
  const header = new Uint8Array(4);
  const v = new DataView(header.buffer);
  v.setUint8(0, len & 0xff);
  v.setUint8(1, (len >> 8) & 0xff);
  v.setUint8(2, (len >> 16) & 0xff);
  v.setUint8(3, seq & 0xff);
  const result = new Uint8Array(4 + len);
  result.set(header);
  result.set(payload, 4);
  return result;
}

export function readPacketHeader(data: Uint8Array): { length: number; seq: number } | null {
  if (data.length < 4) return null;
  const len = data[0]! | (data[1]! << 8) | (data[2]! << 16);
  if (data.length < 4 + len) return null;
  return { length: len, seq: data[3]! };
}

// ─── Length-encoded integer ────────────────────────────

export function readLenEncInt(data: Uint8Array, offset: number): { value: number; bytes: number } {
  const b = data[offset]!;
  if (b < 0xfb) return { value: b, bytes: 1 };
  if (b === 0xfc) {
    const v = data[offset + 1]! | (data[offset + 2]! << 8);
    return { value: v, bytes: 3 };
  }
  if (b === 0xfd) {
    const v = data[offset + 1]! | (data[offset + 2]! << 8) | (data[offset + 3]! << 16);
    return { value: v, bytes: 4 };
  }
  // 0xfe for 8-byte int, but we'll handle as 4-byte for simplicity
  const v = data[offset + 1]! | (data[offset + 2]! << 8) | (data[offset + 3]! << 16) | (data[offset + 4]! << 24);
  return { value: v >>> 0, bytes: 9 };
}

export function readLenEncString(data: Uint8Array, offset: number): { value: string; bytes: number } {
  const len = readLenEncInt(data, offset);
  const str = textDecoder.decode(data.subarray(offset + len.bytes, offset + len.bytes + len.value));
  return { value: str, bytes: len.bytes + len.value };
}

export function readEOFString(data: Uint8Array, offset: number): { value: string; bytes: number } {
  const end = data.indexOf(0, offset);
  if (end === -1) return { value: textDecoder.decode(data.subarray(offset)), bytes: data.length - offset };
  return { value: textDecoder.decode(data.subarray(offset, end)), bytes: end - offset + 1 };
}

// ─── Handshake (server greeting) ───────────────────────

export interface HandshakePacket {
  protocolVersion: number;
  serverVersion: string;
  connectionId: number;
  authData1: Uint8Array;
  authData2: Uint8Array;
  authPluginName: string;
  capabilities: number;
  characterSet: number;
  statusFlags: number;
}

export function parseHandshake(data: Uint8Array): HandshakePacket {
  let off = 0;
  const protocolVersion = data[off]!; off += 1;
  const readSv = readEOFString(data, off); off += readSv.bytes;
  const serverVersion = readSv.value;
  const v = new DataView(data.buffer, data.byteOffset + off, data.byteLength - off);
  const connectionId = v.getUint32(0, true); off += 4;
  const authData1 = data.subarray(off, off + 8); off += 8;
  off += 1; // filler
  const capabilitiesLow = v.getUint16(0, true); off += 2;
  const characterSet = data[off]!; off += 1;
  const statusFlags = v.getUint16(off, true); off += 2;
  const capabilitiesHigh = v.getUint16(off, true); off += 2;
  const capabilities = (capabilitiesHigh << 16) | capabilitiesLow;
  const authDataLen = data[off]!; off += 1;
  off += 10; // reserved
  const authData2Len = Math.max(13, authDataLen - 8);
  const authData2 = data.subarray(off, off + authData2Len - 1); off += authData2Len;
  let authPluginName = "";
  if (capabilities & CLIENT_PLUGIN_AUTH) {
    const an = readEOFString(data, off);
    authPluginName = an.value;
  }
  return { protocolVersion, serverVersion, connectionId, authData1, authData2, authPluginName, capabilities, characterSet, statusFlags };
}

// ─── Auth: mysql_native_password ───────────────────────

export function nativePasswordAuth(password: string, scramble: Uint8Array): Uint8Array {
  // SHA1(password)
  const stage1 = sha1(textEncoder.encode(password));
  // SHA1(stage1)
  const stage2 = sha1(new Uint8Array(stage1.buffer));
  // SHA1(scramble + stage2)
  const combined = new Uint8Array(scramble.length + stage2.length);
  combined.set(scramble);
  combined.set(new Uint8Array(stage2.buffer), scramble.length);
  const result = sha1(combined);
  // XOR result with stage1
  for (let i = 0; i < 20; i++) {
    result[i]! ^= stage1[i]!;
  }
  return new Uint8Array(result);
}

function sha1(data: Uint8Array): Uint8Array {
  // SHA-1 implementation (FIPS 180-4)
  const ml = data.length * 8;
  const padded = new Uint8Array(((data.length + 9 + 63) >>> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 4, ml >>> 0, false);
  dv.setUint32(padded.length - 8, Math.floor(ml / 0x100000000), false);

  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;

  for (let i = 0; i < padded.length; i += 64) {
    const w: number[] = [];
    for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4, false);
    for (let j = 16; j < 80; j++) {
      const n = w[j - 3]! ^ w[j - 8]! ^ w[j - 14]! ^ w[j - 16]!;
      w[j] = (n << 1) | (n >>> 31);
    }
    let [a, b, c, d, e] = [h0, h1, h2, h3, h4];
    for (let j = 0; j < 80; j++) {
      const f = j < 20 ? (b & c) | (~b & d)
        : j < 40 ? b ^ c ^ d
        : j < 60 ? (b & c) | (b & d) | (c & d)
        : b ^ c ^ d;
      const k = j < 20 ? 0x5a827999 : j < 40 ? 0x6ed9eba1 : j < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const temp = ((a << 5) | (a >>> 27)) + f + e + k + w[j]!;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = temp >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }

  const hash = new Uint8Array(20);
  const dh = new DataView(hash.buffer);
  dh.setUint32(0, h0, false); dh.setUint32(4, h1, false);
  dh.setUint32(8, h2, false); dh.setUint32(12, h3, false); dh.setUint32(16, h4, false);
  return hash;
}

// ─── Handshake Response ────────────────────────────────

export function encodeHandshakeResponse(
  params: { user: string; password: string; database: string },
  handshake: HandshakePacket,
): Uint8Array {
  const capabilities = CLIENT_PROTOCOL_41 | CLIENT_SECURE_CONNECTION | CLIENT_PLUGIN_AUTH | CLIENT_PLUGIN_AUTH_LENENC | CLIENT_CONNECT_WITH_DB | CLIENT_DEPRECATE_EOF;
  const scramble = concatBytes(handshake.authData1, handshake.authData2);
  const authResp = params.password ? nativePasswordAuth(params.password, scramble) : new Uint8Array(0);

  const payloadChunks: Uint8Array[] = [
    uint32LE(capabilities),
    uint32LE(0x01000000), // max packet size
    uint8(handshake.characterSet), // charset
    new Uint8Array(23), // reserved
    concatBytes(textEncoder.encode(params.user + "\0")),
    uint8(authResp.length),
    authResp,
  ];
  
  if (params.database) {
    payloadChunks.push(textEncoder.encode(params.database + "\0"));
  }
  
  payloadChunks.push(textEncoder.encode("mysql_native_password\0"));

  return encodePacket(1, concatBytes(...payloadChunks));
}

// ─── COM_QUERY ─────────────────────────────────────────

export function encodeQueryPacket(seq: number, sql: string): Uint8Array {
  const payload = new Uint8Array(1 + sql.length);
  payload[0] = 0x03; // COM_QUERY
  textEncoder.encodeInto(sql, payload.subarray(1));
  return encodePacket(seq, payload);
}

// ─── Prepared Statements ──────────────────────────────

export function encodeStmtPrepare(seq: number, sql: string): Uint8Array {
  const payload = new Uint8Array(1 + sql.length);
  payload[0] = 0x16; // COM_STMT_PREPARE
  textEncoder.encodeInto(sql, payload.subarray(1));
  return encodePacket(seq, payload);
}

export function encodeStmtExecute(seq: number, stmtId: number, params: (Uint8Array | null)[], paramTypes?: number[]): Uint8Array {
  const nullBitmapLen = Math.ceil(params.length / 8);
  // Compute total size: header + (type(2) + unsigned(1) + lenenc(N) + value(M)) for each param
  let totalLen = 1 + 4 + 1 + 4 + nullBitmapLen + 1;
  const valueSegments: Uint8Array[] = [];
  for (let i = 0; i < params.length; i++) {
    totalLen += 2; // type(1) + unsigned(1)
    const p = params[i];
    if (p !== null && p !== undefined) {
      const lenEnc = encodeLenEnc(p.length);
      valueSegments.push(lenEnc);
      valueSegments.push(p);
      totalLen += lenEnc.length + p.length;
    }
  }

  const payload = new Uint8Array(totalLen);
  let off = 0;
  payload[off++] = 0x17;
  new DataView(payload.buffer).setUint32(off, stmtId, true); off += 4;
  payload[off++] = 0;
  new DataView(payload.buffer).setUint32(off, 1, true); off += 4;

  for (let i = 0; i < nullBitmapLen; i++) {
    let byte = 0;
    for (let b = 0; b < 8; b++) {
      const idx = i * 8 + b;
      if (idx < params.length && params[idx] === null) byte |= (1 << b);
    }
    payload[off++] = byte;
  }

  payload[off++] = 1; // new_params_bound_flag = 1 (all types as VAR_STRING)

  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    payload[off++] = 0x0f; // MYSQL_TYPE_VAR_STRING (1 byte, not LE uint16!)
    payload[off++] = 0;    // unsigned flag
    if (p !== null && p !== undefined) {
      const lenEnc = encodeLenEnc(p.length);
      for (const b of lenEnc) payload[off++] = b;
      for (const b of p) payload[off++] = b;
    }
  }

  return encodePacket(seq, payload);
}

export function encodeStmtClose(seq: number, stmtId: number): Uint8Array {
  const payload = new Uint8Array(5);
  payload[0] = 0x19; // COM_STMT_CLOSE
  new DataView(payload.buffer).setUint32(1, stmtId, true);
  return encodePacket(seq, payload);
}

export interface PrepareOKPacket {
  type: "prepare_ok";
  statementId: number;
  columnCount: number;
  paramCount: number;
  warningCount: number;
  paramTypes: number[]; // MySQL type codes from param definitions
}

// ─── Response parsing ─────────────────────────────────

export interface OKPacket {
  type: "ok";
  affectedRows: number;
  lastInsertId: number;
  statusFlags: number;
  warnings: number;
  info: string;
}

export interface ERRPacket {
  type: "error";
  code: number;
  message: string;
  sqlState: string;
}

export interface ColumnDefinition {
  catalog: string;
  schema: string;
  table: string;
  orgTable: string;
  name: string;
  orgName: string;
  charset: number;
  columnLength: number;
  type: number;
  flags: number;
  decimals: number;
}

export interface ResultSetPacket {
  type: "resultset";
  columns: ColumnDefinition[];
  rows: (Uint8Array | null)[][];
}

export type ResponsePacket = OKPacket | ERRPacket | ResultSetPacket;

export function parseResponse(packets: Uint8Array[]): ResponsePacket {
  const first = packets[0]!;
  if (first.length === 0) throw new Error("Empty response");

  const header = first[0]!;

  // ERR packet
  if (header === 0xff) {
    return parseError(first);
  }

  // OK packet (header 0x00 or first byte > 0xfa for result set column count)
  // Note: OK packet starts with 0x00 or 0xFE (when CLIENT_DEPRECATE_EOF)
  if (header === 0x00) {
    return parseOK(first);
  }

  // ResultSet: first byte is column count (length-encoded integer)
  // For a result set, the column count is typically 1+ bytes
  // OK packet with DEPRECATE_EOF can start with header 0xFE too
  if (header === 0xfe && first.length < 9) {
    // EOF packet (could be auth switch too, but we handle that separately)
    // With CLIENT_DEPRECATE_EOF, last packet after rows is OK, not EOF
    // Without CLIENT_DEPRECATE_EOF, we get EOF after column defs and after rows
    return parseOK(first); // Treat as OK for simplicity
  }

  // If first byte is > 0 and < 0xfb, it could be a column count
  // MySQL column count is a length-encoded integer which starts with certain byte patterns
  // 0xfb is NULL in length-encoded int, not a valid column count

  // ResultSet: first packet is column count
  const colCount = readLenEncInt(first, 0);
  if (colCount.value > 0 && colCount.value < 1000 && packets.length > 1) {
    // Need to parse column definitions and rows
    return parseResultSet(colCount.value, packets);
  }

  // If we got here and first byte is 0xfe, it's likely OK with DEPRECATE_EOF
  if (header === 0xfe) {
    return parseOK(first);
  }

  throw new Error(`Unknown response: header=0x${header.toString(16)}`);
}

export function parsePrepareOK(first: Uint8Array, packets: Uint8Array[]): PrepareOKPacket {
  if (first[0] === 0xff) {
    const err = parseError(first);
    throw new WireError(err.message, err.code);
  }
  // MySQL 8.0: 0x00 OK header + 4-byte stmt_id + 2-byte columns + 2-byte params + 1 filler + 2 warning
  const v = new DataView(first.buffer, first.byteOffset, first.byteLength);
  let off = 1; // skip OK header
  const stmtId = v.getUint32(off, true); off += 4;
  const columnCount = v.getUint16(off, true); off += 2;
  const paramCount = v.getUint16(off, true); off += 2;
  off += 1; // filler
  const warningCount = v.getUint16(off, true); off += 2;

  // Extract param types from subsequent packets (param definitions come first, then column definitions)
  const paramTypes: number[] = [];
  const packetIdx = 1;
  for (let i = 0; i < paramCount; i++) {
    const pkt = packets[packetIdx + i];
    if (pkt && pkt.length >= 5) {
      const type = pkt[pkt.length - 6]!;
      paramTypes.push(type);
    } else {
      paramTypes.push(0x0f);
    }
  }

  return { type: "prepare_ok", statementId: stmtId, columnCount, paramCount, warningCount, paramTypes };
}

export class WireError extends Error {
  readonly code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "WireError";
    this.code = code;
  }
}

function parseOK(data: Uint8Array): OKPacket {
  let off = 1; // skip header
  const ar = readLenEncInt(data, off); off += ar.bytes;
  const li = readLenEncInt(data, off); off += li.bytes;
  const v = new DataView(data.buffer, data.byteOffset + off, data.byteLength - off);
  const statusFlags = data.length > off + 2 ? v.getUint16(0, true) : 0; off += 2;
  const warnings = data.length > off + 2 ? v.getUint16(off, true) : 0; off += 2;
  const info = data.length > off ? textDecoder.decode(data.subarray(off)) : "";
  return { type: "ok", affectedRows: ar.value, lastInsertId: li.value, statusFlags, warnings, info };
}

function parseError(data: Uint8Array): ERRPacket {
  let off = 1; // skip 0xff
  const code = data[off]! | (data[off + 1]! << 8); off += 2;
  let sqlState = "";
  if (data[off] === 0x23) { // '#'
    sqlState = textDecoder.decode(data.subarray(off, off + 5)); off += 5;
  }
  const message = textDecoder.decode(data.subarray(off));
  return { type: "error", code, message, sqlState };
}

function parseResultSet(colCount: number, packets: Uint8Array[]): ResultSetPacket {
  // Packet 0: column count (already parsed)
  // Packets 1 to colCount: column definitions
  // Last packet before rows: EOF (if !CLIENT_DEPRECATE_EOF)
  // Then rows (each row is a packet)
  // Final packet: OK or EOF

  const columns: ColumnDefinition[] = [];
  let packetIdx = 1;

  // Column definitions
  for (let i = 0; i < colCount && packetIdx < packets.length; i++) {
    const col = parseColumnDefinition(packets[packetIdx]!);
    columns.push(col);
    packetIdx++;
  }

  // Skip EOF packet if present (between column defs and rows)
  if (packetIdx < packets.length) {
    const p = packets[packetIdx]!;
    if (p[0] === 0xfe && p.length < 9) {
      packetIdx++;
    }
  }

  // Rows
  const rows: (Uint8Array | null)[][] = [];
  while (packetIdx < packets.length) {
    const p = packets[packetIdx]!;
    packetIdx++;
    // Last packet: EOF (0xfe with short length) or OK (0x00 or 0xfe with longer payload)
    if (p[0] === 0xfe && p.length < 9) break;
    if (p[0] === 0x00 && p.length < 9) break;
    if (p[0] === 0xff) break; // error
    // Data row
    const row = parseTextRow(p, colCount);
    rows.push(row);
  }

  return { type: "resultset", columns, rows };
}

function parseColumnDefinition(data: Uint8Array): ColumnDefinition {
  let off = 0;
  const catalog = readLenEncString(data, off); off += catalog.bytes;
  const schema = readLenEncString(data, off); off += schema.bytes;
  const table = readLenEncString(data, off); off += table.bytes;
  const orgTable = readLenEncString(data, off); off += orgTable.bytes;
  const name = readLenEncString(data, off); off += name.bytes;
  const orgName = readLenEncString(data, off); off += orgName.bytes;
  // Metadata fields at fixed positions from end of packet
  const len = data.length;
  const charset = (data[len - 12]!) | (data[len - 11]! << 8);
  const columnLength = (data[len - 10]!) | (data[len - 9]! << 8) | (data[len - 8]! << 16) | (data[len - 7]! << 24);
  const type = data[len - 6]!;
  const flags = (data[len - 5]!) | (data[len - 4]! << 8);
  const decimals = data[len - 3]!;
  return { catalog: catalog.value, schema: schema.value, table: table.value, orgTable: orgTable.value, name: name.value, orgName: orgName.value, charset, columnLength, type, flags, decimals };
}

function parseTextRow(data: Uint8Array, colCount: number): (Uint8Array | null)[] {
  let off = 0;
  const row: (Uint8Array | null)[] = [];
  for (let i = 0; i < colCount && off < data.length; i++) {
    if (data[off]! === 0xfb) {
      row.push(null);
      off += 1;
    } else {
      const len = readLenEncInt(data, off);
      off += len.bytes;
      if (len.value === 0) {
        row.push(new Uint8Array(0));
      } else {
        row.push(data.subarray(off, off + len.value));
        off += len.value;
      }
    }
  }
  return row;
}

// ─── Multi-packet assembly ────────────────────────────

export function assemblePackets(data: Uint8Array): Uint8Array[] {
  const packets: Uint8Array[] = [];
  let off = 0;
  while (off < data.length) {
    if (data.length - off < 4) break;
    const len = data[off]! | (data[off + 1]! << 8) | (data[off + 2]! << 16);
    if (data.length - off < 4 + len) break;
    const payload = data.subarray(off + 4, off + 4 + len);
    packets.push(payload);
    off += 4 + len;
  }
  return packets;
}

// ─── Helpers ───────────────────────────────────────────

function uint8(value: number): Uint8Array {
  return new Uint8Array([value & 0xff]);
}

function uint32LE(value: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, value, true);
  return buf;
}

function uint16LE(value: number): Uint8Array {
  const buf = new Uint8Array(2);
  new DataView(buf.buffer).setUint16(0, value, true);
  return buf;
}

function encodeLenEnc(value: number): Uint8Array {
  if (value < 0xfb) return new Uint8Array([value]);
  if (value < 0x10000) return new Uint8Array([0xfc, value & 0xff, (value >> 8) & 0xff]);
  if (value < 0x1000000) return new Uint8Array([0xfd, value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff]);
  return new Uint8Array([0xfe, value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff]);
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export { concatBytes, uint32LE, uint8 };
export type { };
