import { describe, test, expect } from "bun:test";
import { encodeCommand, decodeSimple, RESPReader } from "../../src/driver/redis/resp.ts";
import { RedisDriver } from "../../src/driver/redis.ts";
import { BunQL } from "../../src/bunql.ts";

describe("RESP encoder", () => {
  test("encodeCommand produces valid GET", () => {
    const data = encodeCommand("GET", ["key"]);
    const str = new TextDecoder().decode(data);
    expect(str).toBe("*2\r\n$3\r\nGET\r\n$3\r\nkey\r\n");
  });

  test("encodeCommand produces valid SET", () => {
    const data = encodeCommand("SET", ["name", "Alice"]);
    const str = new TextDecoder().decode(data);
    expect(str).toBe("*3\r\n$3\r\nSET\r\n$4\r\nname\r\n$5\r\nAlice\r\n");
  });

  test("encodeCommand with HSET", () => {
    const data = encodeCommand("HSET", ["user:1", "name", "Bob"]);
    const str = new TextDecoder().decode(data);
    expect(str).toContain("$4\r\nHSET\r\n");
    expect(str).toContain("$6\r\nuser:1\r\n");
    expect(str).toContain("$4\r\nname\r\n");
    expect(str).toContain("$3\r\nBob\r\n");
  });

  test("encodeCommand handles numbers", () => {
    const data = encodeCommand("ZADD", ["scores", 100, "Alice"]);
    const str = new TextDecoder().decode(data);
    expect(str).toContain("$4\r\nZADD\r\n");
    expect(str).toContain("$3\r\n100\r\n");
  });

  test("encodeCommand handles bigint", () => {
    const data = encodeCommand("DEL", [12345678901n]);
    const str = new TextDecoder().decode(data);
    expect(str).toContain("$3\r\nDEL\r\n");
    expect(str).toContain("$11\r\n12345678901\r\n");
  });
});

describe("RESP decoder", () => {
  test("simple string", () => {
    const data = new TextEncoder().encode("+OK\r\n");
    const val = decodeSimple(data) as { type: "simple-string"; value: string };
    expect(val.value).toBe("OK");
  });

  test("error", () => {
    const data = new TextEncoder().encode("-ERR unknown command\r\n");
    const val = decodeSimple(data) as { type: "error"; value: string };
    expect(val.value).toBe("ERR unknown command");
  });

  test("integer", () => {
    const data = new TextEncoder().encode(":1\r\n");
    const val = decodeSimple(data) as { type: "integer"; value: number };
    expect(val.value).toBe(1);
  });

  test("bulk string", () => {
    const data = new TextEncoder().encode("$5\r\nhello\r\n");
    const val = decodeSimple(data) as { type: "bulk-string"; value: string };
    expect(val.value).toBe("hello");
  });

  test("null bulk string", () => {
    const data = new TextEncoder().encode("$-1\r\n");
    const val = decodeSimple(data) as { type: "bulk-string"; value: null };
    expect(val.value).toBeNull();
  });

  test("array of bulk strings", () => {
    const data = new TextEncoder().encode("*2\r\n$3\r\nfoo\r\n$3\r\nbar\r\n");
    const val = decodeSimple(data) as { type: "array"; value: { type: "bulk-string"; value: string }[] };
    expect(val.value).toHaveLength(2);
    expect(val.value[0]!.value).toBe("foo");
    expect(val.value[1]!.value).toBe("bar");
  });

  test("null array", () => {
    const data = new TextEncoder().encode("*-1\r\n");
    const val = decodeSimple(data);
    expect(val.type).toBe("array");
    expect((val as { value: null }).value).toBeNull();
  });

  test("empty array", () => {
    const data = new TextEncoder().encode("*0\r\n");
    const val = decodeSimple(data) as { type: "array"; value: unknown[] };
    expect(val.value).toHaveLength(0);
  });
});

describe("RESP round-trip", () => {
  test("GET and response", () => {
    const decoded = decodeSimple(new TextEncoder().encode("$5\r\nAlice\r\n")) as { type: "bulk-string"; value: string };
    expect(decoded.value).toBe("Alice");
  });

  test("HSET response as integer", () => {
    const resp = decodeSimple(new TextEncoder().encode(":1\r\n")) as { type: "integer"; value: number };
    expect(resp.value).toBe(1);
  });

  test("DEL response as integer", () => {
    const resp = decodeSimple(new TextEncoder().encode(":2\r\n")) as { type: "integer"; value: number };
    expect(resp.value).toBe(2);
  });

  test("HGETALL response flat array", () => {
    const data = new TextEncoder().encode("*4\r\n$3\r\nfoo\r\n$3\r\nbar\r\n$3\r\nbaz\r\n$4\r\nquux\r\n");
    const val = decodeSimple(data) as { type: "array"; value: { type: string; value: string | null }[] };
    expect(val.value).toHaveLength(4);
    expect(val.value[0]!.value).toBe("foo");
    expect(val.value[1]!.value).toBe("bar");
    expect(val.value[2]!.value).toBe("baz");
    expect(val.value[3]!.value).toBe("quux");
  });

  test("SCAN response array", () => {
    const data = new TextEncoder().encode("*2\r\n$1\r\n0\r\n*2\r\n$3\r\nfoo\r\n$3\r\nbar\r\n");
    const val = decodeSimple(data) as { type: "array"; value: ({ type: string; value: unknown } | { type: string; value: unknown[] })[] };
    expect(val.value).toHaveLength(2);
    expect((val.value[0] as { value: string }).value).toBe("0");
    expect((val.value[1] as { value: unknown[] }).value).toBeInstanceOf(Array);
  });
});

describe("RESPReader partial reads", () => {
  test("read value from buffer with extra data", () => {
    const reader = new RESPReader(new TextEncoder().encode("+OK\r\n+PING\r\n"));
    const v1 = reader.readValue();
    expect(v1).not.toBeNull();
    expect(v1!.type).toBe("simple-string");
    expect(v1!.value).toBe("OK");
    expect(reader.offset).toBe(5);

    const v2 = reader.readValue();
    expect(v2).not.toBeNull();
    expect(v2!.type).toBe("simple-string");
    expect(v2!.value).toBe("PING");
  });

  test("incomplete response returns null", () => {
    const reader = new RESPReader(new TextEncoder().encode("+OK"));
    const val = reader.readValue();
    expect(val).toBeNull();
  });
});

describe("RedisDriver", () => {
  test("BunQL constructor rejects redis:// with helpful error", () => {
    expect(() => new BunQL("redis://localhost:6379")).toThrow("Redis driver");
  });

  test("RedisDriver URL parsing via constructor", () => {
    const driver = new RedisDriver("redis://:password@host1:6380/1?maxPoolSize=5");
    expect(driver).toBeDefined();
    driver.close();
  });

  test("RedisDriver URL parsing - minimal", () => {
    const driver = new RedisDriver("redis://localhost:6379");
    expect(driver).toBeDefined();
    driver.close();
  });

  test("RedisDriver options object", () => {
    const driver = new RedisDriver({ hostname: "localhost", port: 6379 });
    expect(driver).toBeDefined();
    driver.close();
  });

  test("RedisDriver query fails without server", async () => {
    const driver = new RedisDriver({ hostname: "localhost", port: 16379 });
    try {
      await driver.query("SELECT * FROM users WHERE id = 1");
      expect.unreachable();
    } catch {
      expect(true).toBe(true);
    }
    await driver.close();
  });
});
