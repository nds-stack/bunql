/**
 * @module driver/mongodb/wire-protocol
 * @description OP_MSG (MongoDB 3.6+) wire protocol — custom implementation, zero deps.
 */

import { encodeBSON, encodeBSONCommand } from "./bson-encoder";
import { decodeBSON, decodeBSONDocuments } from "./bson-decoder";

export const OP_MSG = 2013;
export const OP_REPLY = 1;

let nextRequestId = 1;
export function allocateRequestId(): number {
  return nextRequestId++;
}

function int32LE(value: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setInt32(0, value, true);
  return buf;
}

export interface WireHeader {
  messageLength: number;
  requestID: number;
  responseTo: number;
  opCode: number;
}

export function readHeader(data: Uint8Array): WireHeader {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    messageLength: view.getInt32(0, true),
    requestID: view.getInt32(4, true),
    responseTo: view.getInt32(8, true),
    opCode: view.getInt32(12, true),
  };
}

export function buildCommand(
  db: string,
  command: Record<string, unknown>,
  requestId?: number,
): Uint8Array {
  const rid = requestId ?? allocateRequestId();
  const bodyDoc = encodeBSONCommand(db, command);

  const sectionKind = new Uint8Array([0]);
  const body = concat([sectionKind, bodyDoc]);

  const headerLen = 16;
  const totalLen = headerLen + 4 + body.length;
  const flagBits = int32LE(0);

  const header = new Uint8Array(headerLen);
  const hView = new DataView(header.buffer);
  hView.setInt32(0, totalLen, true);
  hView.setInt32(4, rid, true);
  hView.setInt32(8, 0, true); // responseTo = 0
  hView.setInt32(12, OP_MSG, true);

  return concat([header, flagBits, body]);
}

export function parseResponse(data: Uint8Array): Record<string, unknown> {
  const header = readHeader(data);
  if (header.opCode !== OP_MSG) {
    throw new Error(`Unexpected opCode: ${header.opCode}, expected OP_MSG (${OP_MSG})`);
  }

  let offset = 16;
  const flagBits = new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, true);
  offset += 4;

  const hasChecksum = (flagBits & 1) !== 0;

  const responseDoc = decodeBSON(data.subarray(offset + 1));
  const docLen = new DataView(data.buffer, data.byteOffset + offset + 1, 4).getInt32(0, true);
  offset += 1 + docLen;

  if (hasChecksum) offset += 4;

  return responseDoc;
}

export function parseResponseMultiple(data: Uint8Array): Record<string, unknown>[] {
  const header = readHeader(data);
  if (header.opCode !== OP_MSG) {
    throw new Error(`Unexpected opCode: ${header.opCode}`);
  }

  let offset = 16;
  const flagBits = new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, true);
  offset += 4;

  const hasChecksum = (flagBits & 1) !== 0;
  const docs: Record<string, unknown>[] = [];

  while (offset < data.length - (hasChecksum ? 5 : 1)) {
    const kind = data[offset];
    offset += 1;

    if (kind === 0) {
      const doc = decodeBSON(data.subarray(offset));
      const docLen = new DataView(data.buffer, data.byteOffset + offset, 4).getInt32(0, true);
      offset += docLen;
      docs.push(doc);
    } else if (kind === 1) {
      const seqSize = new DataView(data.buffer, data.byteOffset + offset, 4).getInt32(0, true);
      offset += 4;
      const seqDocs = decodeBSONDocuments(data.subarray(offset, offset + seqSize - 4));
      offset += seqSize - 4;
      docs.push(...seqDocs);
    } else {
      break;
    }
  }

  return docs;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export type { };
