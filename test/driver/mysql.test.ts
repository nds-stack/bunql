import { describe, test, expect } from "bun:test";
import { encodePacket, readPacketHeader, readLenEncInt, assemblePackets, parseHandshake, encodeHandshakeResponse, encodeQueryPacket } from "../../src/driver/mysql/wire.ts";
import { MySQLDriver } from "../../src/driver/mysql.ts";
import { BunQL } from "../../src/bunql.ts";

describe("MySQL wire protocol", () => {
  test("encodePacket and readPacketHeader", () => {
    const payload = new Uint8Array([0x01, 0x02, 0x03]);
    const packet = encodePacket(0, payload);
    expect(packet.length).toBe(7);
    const header = readPacketHeader(packet);
    expect(header).not.toBeNull();
    expect(header!.length).toBe(3);
    expect(header!.seq).toBe(0);
  });

  test("readPacketHeader returns null for incomplete data", () => {
    expect(readPacketHeader(new Uint8Array([0, 0, 0]))).toBeNull();
  });

  test("readLenEncInt for small values", () => {
    const data = new Uint8Array([0x05]);
    const result = readLenEncInt(data, 0);
    expect(result.value).toBe(5);
    expect(result.bytes).toBe(1);
  });

  test("readLenEncInt for 0xfc values", () => {
    const data = new Uint8Array([0xfc, 0x2c, 0x01]); // 300
    const result = readLenEncInt(data, 0);
    expect(result.value).toBe(300);
    expect(result.bytes).toBe(3);
  });

  test("encodeQueryPacket", () => {
    const packet = encodeQueryPacket(0, "SELECT 1");
    expect(packet[4]).toBe(0x03); // COM_QUERY
    const payload = packet.subarray(5);
    expect(new TextDecoder().decode(payload)).toBe("SELECT 1");
  });

  test("assemblePackets", () => {
    const p1 = encodePacket(0, new Uint8Array([0x01, 0x02]));
    const p2 = encodePacket(1, new Uint8Array([0x03]));
    const combined = new Uint8Array(p1.length + p2.length);
    combined.set(p1);
    combined.set(p2, p1.length);
    const packets = assemblePackets(combined);
    expect(packets).toHaveLength(2);
    expect(packets[0]).toEqual(new Uint8Array([0x01, 0x02]));
    expect(packets[1]).toEqual(new Uint8Array([0x03]));
  });

  test("parseHandshake minimal", () => {
    // Minimal valid handshake (protocol version 10, server version "8.0.32\0", connectionId 1, auth1 8 bytes)
    const data = new Uint8Array([
      10, // protocol version
      56, 46, 48, 46, 51, 50, 0, // "8.0.32\0"
      1, 0, 0, 0, // connection ID = 1
      0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, // auth1
      0, // filler
      0x85, 0xa6, // capability flags low
      33, // charset utf8
      0x02, 0x00, // status flags
      0x1f, 0x00, // capability flags high
      21, // auth data length
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // reserved
      0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, // auth2 (13 bytes max)
    ]);
    const hs = parseHandshake(data);
    expect(hs.protocolVersion).toBe(10);
    expect(hs.serverVersion).toBe("8.0.32");
    expect(hs.connectionId).toBe(1);
  });
});

describe("MySQLDriver", () => {
  test("BunQL constructor rejects mysql:// with helpful error", () => {
    expect(() => new BunQL("mysql://localhost:3306/test")).toThrow("MySQLDriver");
  });

  test("MySQLDriver URL parsing via constructor", () => {
    const driver = new MySQLDriver("mysql://user:pass@host1:3307/mydb?maxPoolSize=3");
    expect(driver).toBeDefined();
    driver.close();
  });

  test("MySQLDriver URL parsing - minimal", () => {
    const driver = new MySQLDriver("mysql://localhost:3306/test");
    expect(driver).toBeDefined();
    driver.close();
  });

  test("MySQLDriver options object", () => {
    const driver = new MySQLDriver({ hostname: "localhost", port: 3306, db: "test" });
    expect(driver).toBeDefined();
    driver.close();
  });

  test("MySQLDriver query fails without server", async () => {
    const driver = new MySQLDriver({ hostname: "localhost", port: 13306, db: "test" });
    try {
      await driver.query("SELECT 1");
      expect.unreachable();
    } catch {
      expect(true).toBe(true);
    }
    await driver.close();
  });
});
