/**
 * @module driver/mongodb/bson-encoder
 * @description BSON encoder — JavaScript → BSON bytes (custom, zero-dependency).
 * Subset: string, int32, int64, double, boolean, null, document, array, ObjectId, Date, Binary, RegExp, Timestamp.
 */

const encoder = new TextEncoder();

function cstring(str: string): Uint8Array {
  const encoded = encoder.encode(str);
  const result = new Uint8Array(encoded.length + 1);
  result.set(encoded);
  return result;
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

function int32LE(value: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setInt32(0, value, true);
  return buf;
}

function int64LE(value: number | bigint): Uint8Array {
  const buf = new Uint8Array(8);
  const v = typeof value === "bigint" ? value : BigInt(value);
  new DataView(buf.buffer).setBigInt64(0, v, true);
  return buf;
}

function doubleLE(value: number): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setFloat64(0, value, true);
  return buf;
}

function typeOf(value: unknown): number {
  if (value === null || value === undefined) return 0x0a;

  switch (typeof value) {
    case "number":
      return Number.isInteger(value) && value >= -2147483648 && value <= 2147483647 ? 0x10 : 0x01;
    case "boolean":
      return 0x08;
    case "string":
      return 0x02;
    case "bigint":
      return 0x12;
    case "object":
      if (Array.isArray(value)) return 0x04;
      if (value instanceof Uint8Array) return value.length === 12 ? 0x07 : 0x05;
      if (value instanceof Date) return 0x09;
      return 0x03;
    default:
      return 0x0a;
  }
}

function encodeElement(name: string, value: unknown): Uint8Array[] {
  const type = typeOf(value);
  const nameBytes = cstring(name);
  const chunks: Uint8Array[] = [new Uint8Array([type]), nameBytes];

  switch (type) {
    case 0x01: {
      chunks.push(doubleLE(value as number));
      break;
    }
    case 0x02: {
      const str = value as string;
      const encoded = encoder.encode(str);
      const lenBuf = int32LE(encoded.length + 1);
      chunks.push(lenBuf, encoded, new Uint8Array([0]));
      break;
    }
    case 0x03: {
      const doc = encodeDocument(value as Record<string, unknown>);
      chunks.push(doc);
      break;
    }
    case 0x04: {
      const arr = value as unknown[];
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < arr.length; i++) obj[String(i)] = arr[i];
      const doc = encodeDocument(obj);
      chunks.push(doc);
      break;
    }
    case 0x05: {
      const bin = value as Uint8Array;
      chunks.push(int32LE(bin.length), new Uint8Array([0]), bin);
      break;
    }
    case 0x07: {
      const oid = value as Uint8Array;
      chunks.push(oid.slice(0, 12));
      break;
    }
    case 0x08: {
      chunks.push(new Uint8Array([value ? 1 : 0]));
      break;
    }
    case 0x09: {
      const d = value as Date;
      chunks.push(int64LE(d.getTime()));
      break;
    }
    case 0x0a: {
      break;
    }
    case 0x0b: {
      const re = value as RegExp;
      const pattern = re.source.includes("\0") ? re.source.replace(/\0/g, "") : re.source;
      let flags = "";
      if (re.flags.includes("i")) flags += "i";
      if (re.flags.includes("m")) flags += "m";
      if (re.flags.includes("s")) flags += "s";
      if (re.flags.includes("x")) flags += "x";
      chunks.push(cstring(pattern), cstring(flags));
      break;
    }
    case 0x10: {
      chunks.push(int32LE(value as number));
      break;
    }
    case 0x11: {
      const ts = value as { t: number; i: number };
      const combined = (BigInt(ts.t) << 32n) | BigInt(ts.i & 0xffffffff);
      chunks.push(int64LE(combined));
      break;
    }
    case 0x12: {
      chunks.push(int64LE(value as bigint));
      break;
    }
  }

  return chunks;
}

function encodeDocument(obj: Record<string, unknown>): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val === undefined) continue;
    chunks.push(...encodeElement(key, val));
  }
  const body = concat(chunks);
  const totalLength = 4 + body.length + 1;
  return concat([int32LE(totalLength), body, new Uint8Array([0])]);
}

export function encodeBSON(value: unknown): Uint8Array {
  if (Array.isArray(value)) {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < value.length; i++) obj[String(i)] = value[i];
    return encodeDocument(obj);
  }
  return encodeDocument(value as Record<string, unknown>);
}

export function encodeBSONCommand(db: string, command: Record<string, unknown>): Uint8Array {
  const doc: Record<string, unknown> = { ...command, $db: db };
  return encodeDocument(doc);
}

export type { };
