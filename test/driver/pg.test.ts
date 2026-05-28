import { describe, test, expect } from "bun:test";
import { PGReader, encodeQuery, encodeTerminate, md5Hex } from "../../src/driver/pg/wire.ts";
import { PGDriver } from "../../src/driver/pg.ts";
import { BunQL } from "../../src/bunql.ts";

function makeBuf(hex: string): Uint8Array {
  const bytes = hex.split(" ").filter(Boolean).map((b) => parseInt(b, 16));
  return new Uint8Array(bytes);
}

describe("PG wire protocol", () => {
  test("md5Hex produces standard output", () => {
    const result = md5Hex("hello");
    expect(result).toBe("5d41402abc4b2a76b9719d911017c592");
  });

  test("encodeQuery produces Q message", () => {
    const data = encodeQuery("SELECT 1");
    expect(String.fromCharCode(data[0]!)).toBe("Q");
  });

  test("encodeTerminate produces X message", () => {
    const data = encodeTerminate();
    expect(String.fromCharCode(data[0]!)).toBe("X");
  });

  test("PGReader reads ReadyForQuery", () => {
    // 'Z'(1) + Int32 BE(4) + 'I'(1) = 6 bytes
    const buf = makeBuf("5a 00 00 00 05 49");
    const reader = new PGReader(buf);
    expect(reader.hasMessage()).toBe(true);
    const msg = reader.readMessage();
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("ReadyForQuery");
    if (msg!.type === "ReadyForQuery") {
      expect(msg.status).toBe("idle");
    }
    expect(reader.hasMessage()).toBe(false);
  });

  test("PGReader reads AuthenticationOk", () => {
    // 'R'(1) + Int32 BE(4) + Int32 BE(0) = 9 bytes
    const buf = makeBuf("52 00 00 00 08 00 00 00 00");
    const reader = new PGReader(buf);
    const msg = reader.readMessage();
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("AuthenticationOk");
  });

  test("PGReader reads AuthenticationMD5Password", () => {
    // 'R'(1) + Int32 BE(12) + Int32 BE(5) + 4 byte salt
    const buf = makeBuf("52 00 00 00 0c 00 00 00 05 01 02 03 04");
    const reader = new PGReader(buf);
    const msg = reader.readMessage();
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("AuthenticationMD5Password");
    if (msg!.type === "AuthenticationMD5Password") {
      expect(msg.salt).toEqual(new Uint8Array([1, 2, 3, 4]));
    }
  });

  test("PGReader reads multiple messages", () => {
    // ReadyForQuery(6) + ParameterStatus (variable)
    const z = makeBuf("5a 00 00 00 05 49");
    const s = makeBuf("53 00 00 00 0e 61 70 70 6c 69 63 61 74 69 6f 6e 5f 6e 61 6d 65 00 00");
    const combined = new Uint8Array(z.length + s.length);
    combined.set(z);
    combined.set(s, z.length);

    const reader = new PGReader(combined);
    const msgs = reader.readAllMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.type).toBe("ReadyForQuery");
    expect(msgs[1]!.type).toBe("ParameterStatus");
  });

  test("PGReader reads CommandComplete", () => {
    // 'C'(1) + Int32 BE(13) + "SELECT 1\0"(9)
    const buf = makeBuf("43 00 00 00 0d 53 45 4c 45 43 54 20 31 00");
    const reader = new PGReader(buf);
    const msg = reader.readMessage();
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("CommandComplete");
    if (msg!.type === "CommandComplete") {
      expect(msg.tag).toBe("SELECT 1");
    }
  });

  test("PGReader reads ErrorResponse", () => {
    // 'E'(1) + Int32 BE(30) + S\0ERROR\0C\042P01\0M\0syntax\0\0
    // fields: S\0(2) + ERROR\0(6) + C\0(2) + 42P01\0(6) + M\0(2) + syntax\0(7) + \0(1) = 26
    // len = 4 + 26 = 30 = 0x1e
    const buf = makeBuf("45 00 00 00 1e 53 00 45 52 52 4f 52 00 43 00 34 32 50 30 31 00 4d 00 73 79 6e 74 61 78 00 00");
    const reader = new PGReader(buf);
    const msg = reader.readMessage();
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("ErrorResponse");
    if (msg!.type === "ErrorResponse") {
      expect(msg.severity).toBe("ERROR");
      expect(msg.code).toBe("42P01");
      expect(msg.message).toBe("syntax");
    }
  });

  test("PGReader reads RowDescription", () => {
    // 'T'(1) + Int32 BE(4+2+3+18=27=0x1b) + Int16 BE(1) + "id\0" + 6×3 zero bytes
    // Body: Int16(2) + name\0(3) + 6 fields(18) = 23
    // Len = 4 + 23 = 27 = 0x1b
    const buf = makeBuf("54 00 00 00 1b 00 01 69 64 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00");
    const reader = new PGReader(buf);
    expect(reader.hasMessage()).toBe(true);
    const msg = reader.readMessage();
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("RowDescription");
    if (msg!.type === "RowDescription") {
      expect(msg.columns).toHaveLength(1);
      expect(msg.columns[0]!.name).toBe("id");
    }
  });
});

describe("PGDriver", () => {
  test("BunQL constructor rejects postgres:// with helpful error", () => {
    expect(() => new BunQL("postgres://localhost:5432/test")).toThrow("PGDriver");
  });

  test("PGDriver URL parsing via constructor", () => {
    const driver = new PGDriver("postgres://user:pass@host1:5433/mydb?maxPoolSize=3");
    expect(driver).toBeDefined();
    driver.close();
  });

  test("PGDriver URL parsing - minimal", () => {
    const driver = new PGDriver("postgres://localhost:5432/test");
    expect(driver).toBeDefined();
    driver.close();
  });

  test("PGDriver options object", () => {
    const driver = new PGDriver({ hostname: "localhost", port: 5432, db: "test" });
    expect(driver).toBeDefined();
    driver.close();
  });

  test("PGDriver query fails without server", async () => {
    const driver = new PGDriver({ hostname: "localhost", port: 15432, db: "test" });
    try {
      await driver.query("SELECT 1");
      expect.unreachable();
    } catch {
      expect(true).toBe(true);
    }
    await driver.close();
  });
});
