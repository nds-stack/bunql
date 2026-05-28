import { describe, test, expect } from "bun:test";
import { buildCommand, readHeader, parseResponse, OP_MSG } from "../../src/driver/mongodb/wire-protocol.ts";
import { decodeBSON } from "../../src/driver/mongodb/bson-decoder.ts";

describe("Wire protocol", () => {
  test("buildCommand produces valid OP_MSG header", () => {
    const data = buildCommand("test", { ping: 1 }, 42);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    const messageLength = view.getInt32(0, true);
    const requestID = view.getInt32(4, true);
    const responseTo = view.getInt32(8, true);
    const opCode = view.getInt32(12, true);

    expect(messageLength).toBe(data.length);
    expect(requestID).toBe(42);
    expect(responseTo).toBe(0);
    expect(opCode).toBe(OP_MSG);
  });

  test("buildCommand contains ping command", () => {
    const data = buildCommand("test", { ping: 1 }, 1);

    const bodyStart = 20;
    const kind = data[bodyStart];
    expect(kind).toBe(0);

    const doc = decodeBSON(data.subarray(bodyStart + 1));
    expect(doc.$db).toBe("test");
    expect(doc.ping).toBe(1);
  });

  test("buildCommand with find command", () => {
    const data = buildCommand("test", {
      find: "users",
      filter: { age: { $gt: 25 } },
    }, 2);

    const bodyStart = 20;
    const doc = decodeBSON(data.subarray(bodyStart + 1));
    expect(doc.$db).toBe("test");
    expect(doc.find).toBe("users");
    expect(doc.filter).toEqual({ age: { $gt: 25 } });
  });

  test("buildCommand with insert command", () => {
    const data = buildCommand("test", {
      insert: "users",
      documents: [{ name: "Alice", age: 30 }],
    }, 3);

    const bodyStart = 20;
    const doc = decodeBSON(data.subarray(bodyStart + 1));
    expect(doc.insert).toBe("users");
    const docs = doc.documents as unknown[];
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ name: "Alice", age: 30 });
  });

  test("readHeader parses correctly", () => {
    const data = buildCommand("test", { ping: 1 }, 99);
    const header = readHeader(data);

    expect(header.messageLength).toBe(data.length);
    expect(header.requestID).toBe(99);
    expect(header.responseTo).toBe(0);
    expect(header.opCode).toBe(OP_MSG);
  });

  test("parseResponse with ok:1", () => {
    const rawResponse = buildResponse({ ok: 1, some: "data" }, 1);
    const result = parseResponse(rawResponse);
    expect(result.ok).toBe(1);
    expect(result.some).toBe("data");
  });

  test("parseResponse with cursor", () => {
    const cursorData = {
      ok: 1,
      cursor: {
        id: 0n,
        ns: "test.users",
        firstBatch: [
          { _id: new Uint8Array(12), name: "Alice" },
          { _id: new Uint8Array(12), name: "Bob" },
        ],
      },
    };
    const rawResponse = buildResponse(cursorData, 2);
    const result = parseResponse(rawResponse);
    expect(result.ok).toBe(1);
    const cursor = result.cursor as Record<string, unknown>;
    expect(cursor.ns).toBe("test.users");
    const batch = cursor.firstBatch as unknown[];
    expect(batch).toHaveLength(2);
  });

  test("parseResponse returns error document (thrown at connection level)", () => {
    const rawResponse = buildResponse({ ok: 0, errmsg: "collection not found", code: 26 }, 3);
    const result = parseResponse(rawResponse);
    expect(result.ok).toBe(0);
    expect(result.errmsg).toBe("collection not found");
    expect(result.code).toBe(26);
  });
});

function buildResponse(doc: Record<string, unknown>, responseTo: number): Uint8Array {
  const { encodeBSON } = require("../../src/driver/mongodb/bson-encoder.ts");
  const bodyDoc = encodeBSON(doc);
  const sectionKind = new Uint8Array([0]);
  const body = concat([sectionKind, bodyDoc]);

  const flagBitsLE = new Uint8Array(4);
  new DataView(flagBitsLE.buffer).setUint32(0, 0, true);

  const headerLen = 16;
  const totalLen = headerLen + 4 + body.length;

  const header = new Uint8Array(headerLen);
  const hView = new DataView(header.buffer);
  hView.setInt32(0, totalLen, true);
  hView.setInt32(4, 0, true);
  hView.setInt32(8, responseTo, true);
  hView.setInt32(12, OP_MSG, true);

  return concat([header, flagBitsLE, body]);
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
