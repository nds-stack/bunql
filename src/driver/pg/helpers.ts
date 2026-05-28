import type { PGColumn } from "./wire";

export function rowsToObjects(columns: PGColumn[], rows: (Uint8Array | null)[][]): Record<string, unknown>[] {
  const textDecoder = new TextDecoder();
  return rows.map((row) => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < columns.length && i < row.length; i++) {
      const val = row[i];
      obj[columns[i]!.name] = val === null ? null : textDecoder.decode(val);
    }
    return obj;
  });
}

export function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
