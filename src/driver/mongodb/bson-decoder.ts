/**
 * @module driver/mongodb/bson-decoder
 * @description BSON decoder — BSON bytes → JavaScript (custom, zero-dependency).
 * Subset: string, int32, int64, double, boolean, null, document, array, ObjectId, Date, Binary, RegExp.
 */

const decoder = new TextDecoder();

export class BSONReader {
  readonly buffer: Uint8Array;
  readonly view: DataView;
  offset = 0;

  constructor(buffer: Uint8Array) {
    this.buffer = buffer;
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  readInt32(): number {
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }

  readInt64(): bigint {
    const v = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return v;
  }

  readDouble(): number {
    const v = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return v;
  }

  readCString(): string {
    const start = this.offset;
    while (this.buffer[this.offset] !== 0) this.offset++;
    const str = decoder.decode(this.buffer.subarray(start, this.offset));
    this.offset++;
    return str;
  }

  readString(): string {
    const len = this.readInt32();
    const str = decoder.decode(this.buffer.subarray(this.offset, this.offset + len - 1));
    this.offset += len;
    return str;
  }

  readBytes(n: number): Uint8Array {
    const slice = this.buffer.subarray(this.offset, this.offset + n);
    this.offset += n;
    return slice;
  }

  readValue(type: number): unknown {
    switch (type) {
      case 0x01: return this.readDouble();
      case 0x02: return this.readString();
      case 0x03: return this.readDocument();
      case 0x04: {
        const arr = this.readDocument();
        const result: unknown[] = [];
        const keys = Object.keys(arr);
        for (let i = 0; i < keys.length; i++) {
          result[i] = arr[keys[i]!];
        }
        return result;
      }
      case 0x05: {
        const len = this.readInt32();
        const subtype = this.buffer[this.offset++]!;
        const data = this.readBytes(len);
        return { binary: true, subtype, data };
      }
      case 0x06: return undefined;
      case 0x07: return this.readBytes(12);
      case 0x08: return this.buffer[this.offset++] !== 0;
      case 0x09: {
        const ms = this.readInt64();
        return new Date(Number(ms));
      }
      case 0x0a: return null;
      case 0x0b: {
        const pattern = this.readCString();
        const flags = this.readCString();
        try {
          return new RegExp(pattern, flags);
        } catch {
          return null;
        }
      }
      case 0x0c: {
        this.readString();
        this.readBytes(12);
        return null;
      }
      case 0x0d: return this.readString();
      case 0x0e: return this.readString();
      case 0x0f: {
        const str = this.readString();
        const scope = this.readDocument();
        return { code: str, scope };
      }
      case 0x10: return this.readInt32();
      case 0x11: {
        const v = this.readInt64();
        return {
          t: Number((v >> 32n) & 0xffffffffn),
          i: Number(v & 0xffffffffn),
        };
      }
      case 0x12: return this.readInt64();
      case 0x13: return this.readBytes(16);
      case 0xff: return null;
      case 0x7f: return null;
      default:
        throw new Error(`Unknown BSON type: 0x${type.toString(16)}`);
    }
  }

  readDocument(): Record<string, unknown> {
    const startOffset = this.offset;
    const totalLength = this.readInt32();
    const endOffset = startOffset + totalLength;
    const result: Record<string, unknown> = {};
    while (this.offset < endOffset - 1) {
      const type = this.buffer[this.offset++]!;
      if (type === 0) break;
      const name = this.readCString();
      const value = this.readValue(type);
      if (value !== undefined) {
        result[name] = value;
      }
    }
    this.offset = endOffset;
    return result;
  }
}

export function decodeBSON(buffer: Uint8Array): Record<string, unknown> {
  const reader = new BSONReader(buffer);
  return reader.readDocument();
}

export function decodeBSONDocuments(data: Uint8Array): Record<string, unknown>[] {
  const reader = new BSONReader(data);
  const docs: Record<string, unknown>[] = [];
  while (reader.offset < data.length - 4) {
    const len = reader.view.getInt32(reader.offset, true);
    if (len < 5 || reader.offset + len > data.length) break;
    docs.push(reader.readDocument());
  }
  return docs;
}

export type { };
