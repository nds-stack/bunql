/**
 * @module driver/redis/resp
 * @description RESP (Redis Serialization Protocol) encoder/decoder — zero deps.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type RESPValue =
  | { type: "simple-string"; value: string }
  | { type: "error"; value: string }
  | { type: "integer"; value: number }
  | { type: "bulk-string"; value: string | null }
  | { type: "array"; value: RESPValue[] | null };

export function encodeCommand(command: string, args: (string | number | bigint)[]): Uint8Array {
  const parts: string[] = [];
  const all = [command, ...args.map(String)];
  parts.push(`*${all.length}\r\n`);
  for (const arg of all) {
    const bytes = encoder.encode(arg);
    parts.push(`$${bytes.length}\r\n${arg}\r\n`);
  }
  return encoder.encode(parts.join(""));
}

export function encodeRawArray(items: string[]): Uint8Array {
  let result = `*${items.length}\r\n`;
  for (const item of items) {
    const bytes = encoder.encode(item);
    result += `$${bytes.length}\r\n${item}\r\n`;
  }
  return encoder.encode(result);
}

export class RESPReader {
  readonly buffer: Uint8Array;
  offset = 0;

  constructor(buffer: Uint8Array) {
    this.buffer = buffer;
  }

  get available(): number {
    return this.buffer.length - this.offset;
  }

  readLine(): string | null {
    const idx = this.buffer.indexOf(0x0a, this.offset);
    if (idx === -1) return null;
    const line = decoder.decode(this.buffer.subarray(this.offset, idx - 1));
    this.offset = idx + 1;
    return line;
  }

  readBytes(n: number): Uint8Array {
    const slice = this.buffer.subarray(this.offset, this.offset + n);
    this.offset += n;
    return slice;
  }

  readValue(): RESPValue | null {
    if (this.offset >= this.buffer.length) return null;

    const type = String.fromCharCode(this.buffer[this.offset]!);
    this.offset++;

    switch (type) {
      case "+": {
        const line = this.readLine();
        if (line === null) return null;
        return { type: "simple-string", value: line };
      }
      case "-": {
        const line = this.readLine();
        if (line === null) return null;
        return { type: "error", value: line };
      }
      case ":": {
        const line = this.readLine();
        if (line === null) return null;
        return { type: "integer", value: parseInt(line, 10) };
      }
      case "$": {
        const line = this.readLine();
        if (line === null) return null;
        const len = parseInt(line, 10);
        if (len === -1) return { type: "bulk-string", value: null };
        const str = decoder.decode(this.buffer.subarray(this.offset, this.offset + len));
        this.offset += len + 2;
        return { type: "bulk-string", value: str };
      }
      case "*": {
        const line = this.readLine();
        if (line === null) return null;
        const count = parseInt(line, 10);
        if (count === -1) return { type: "array", value: null };
        const items: RESPValue[] = [];
        for (let i = 0; i < count; i++) {
          const val = this.readValue();
          if (val === null) return null;
          items.push(val);
        }
        return { type: "array", value: items };
      }
      default:
        throw new Error(`Unknown RESP type: ${type}`);
    }
  }
}

export function decodeSimple(data: Uint8Array): RESPValue {
  const reader = new RESPReader(data);
  const val = reader.readValue();
  if (val === null) throw new Error("Empty response");
  return val;
}

export function encodeBulkString(value: string): Uint8Array {
  const bytes = encoder.encode(value);
  const header = `$${bytes.length}\r\n`;
  return encoder.encode(header + value + "\r\n");
}

export function encodeSimpleString(value: string): Uint8Array {
  return encoder.encode(`+${value}\r\n`);
}

export function encodeInteger(value: number): Uint8Array {
  return encoder.encode(`:${value}\r\n`);
}

export { encoder as respEncoder, decoder as respDecoder };
export type { };
