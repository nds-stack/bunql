import { describe, test, expect } from "bun:test";
import { encodeBSON } from "../../src/driver/mongodb/bson-encoder.ts";
import { decodeBSON } from "../../src/driver/mongodb/bson-decoder.ts";

function roundtrip(value: Record<string, unknown>): Record<string, unknown> {
  const encoded = encodeBSON(value);
  return decodeBSON(encoded);
}

describe("BSON round-trip", () => {
  test("simple document", () => {
    const result = roundtrip({ hello: "world" });
    expect(result.hello).toBe("world");
  });

  test("multiple fields", () => {
    const result = roundtrip({ a: 1, b: "two", c: true, d: null });
    expect(result.a).toBe(1);
    expect(result.b).toBe("two");
    expect(result.c).toBe(true);
    expect(result.d).toBe(null);
  });

  test("nested document", () => {
    const result = roundtrip({ nested: { a: 1, b: "deep" } });
    expect(result.nested).toEqual({ a: 1, b: "deep" });
  });

  test("array", () => {
    const result = roundtrip({ items: [1, "two", true, null] });
    expect(result.items).toEqual([1, "two", true, null]);
  });

  test("nested array", () => {
    const result = roundtrip({ matrix: [[1, 2], [3, 4]] });
    expect(result.matrix).toEqual([[1, 2], [3, 4]]);
  });

  test("boolean values", () => {
    const result = roundtrip({ t: true, f: false });
    expect(result.t).toBe(true);
    expect(result.f).toBe(false);
  });

  test("integer values", () => {
    const result = roundtrip({ zero: 0, positive: 42, negative: -10 });
    expect(result.zero).toBe(0);
    expect(result.positive).toBe(42);
    expect(result.negative).toBe(-10);
  });

  test("double values", () => {
    const result = roundtrip({ pi: 3.14159, large: 2147483648 });
    expect(result.pi).toBeCloseTo(3.14159);
  });

  test("Date value", () => {
    const date = new Date("2024-01-15T10:30:00Z");
    const result = roundtrip({ created: date });
    expect(result.created).toBeInstanceOf(Date);
    expect((result.created as Date).getTime()).toBe(date.getTime());
  });

  test("null value", () => {
    const result = roundtrip({ empty: null });
    expect(result.empty).toBe(null);
  });

  test("ObjectId as Uint8Array", () => {
    const oid = new Uint8Array(12);
    crypto.getRandomValues(oid);
    const result = roundtrip({ _id: oid });
    expect(result._id).toBeInstanceOf(Uint8Array);
    expect((result._id as Uint8Array).length).toBe(12);
  });

  test("Buffer values (Binary)", () => {
    const buf = new Uint8Array([0x01, 0x02, 0x03, 0xff]);
    const input = { data: buf };
    const encoded = encodeBSON(input);
    const decoded = decodeBSON(encoded);

    expect(decoded.data).toBeDefined();
    if (decoded.data && typeof decoded.data === "object" && "binary" in (decoded.data as object)) {
      const binData = decoded.data as { binary: boolean; subtype: number; data: Uint8Array };
      expect(binData.subtype).toBe(0);
      expect(Array.from(binData.data)).toEqual([0x01, 0x02, 0x03, 0xff]);
    } else {
      expect(decoded.data).toBeInstanceOf(Uint8Array);
    }
  });

  test("deeply nested document", () => {
    const input = {
      level1: {
        level2: {
          level3: {
            level4: {
              value: "deep",
            },
          },
        },
      },
    };
    const result = roundtrip(input);
    expect((result.level1 as Record<string, unknown>).level2).toBeDefined();
    const l3 = (result.level1 as Record<string, unknown>).level2 as Record<string, unknown>;
    const l4 = l3.level3 as Record<string, unknown>;
    expect((l4.level4 as Record<string, unknown>).value).toBe("deep");
  });

  test("empty document", () => {
    const result = roundtrip({});
    expect(result).toEqual({});
  });

  test("mixed types in array", () => {
    const input = {
      mixed: [
        42,
        "string",
        true,
        null,
        { key: "val" },
        [1, 2, 3],
        new Date(0),
        3.14,
      ],
    };
    const encoded = encodeBSON(input);
    const decoded = decodeBSON(encoded);
    const arr = decoded.mixed as unknown[];
    expect(arr.length).toBe(8);
    expect(arr[0]).toBe(42);
    expect(arr[1]).toBe("string");
    expect(arr[2]).toBe(true);
    expect(arr[3]).toBe(null);
    expect(arr[4]).toEqual({ key: "val" });
    expect(arr[5]).toEqual([1, 2, 3]);
    expect(arr[6]).toBeInstanceOf(Date);
    expect((arr[6] as Date).getTime()).toBe(0);
  });

  test("encode decode multiple documents sequentially", () => {
    const docs = [
      { _id: new Uint8Array(12), name: "Alice", age: 30 },
      { _id: new Uint8Array(12), name: "Bob", age: 25 },
      { _id: new Uint8Array(12), name: "Charlie", age: 35 },
    ];

    for (const doc of docs) {
      const result = roundtrip(doc);
      expect(result._id).toBeInstanceOf(Uint8Array);
      expect((result._id as Uint8Array).length).toBe(12);
      expect(result.name).toBe(doc.name);
      expect(result.age).toBe(doc.age);
    }
  });

  test("special characters in strings", () => {
    const result = roundtrip({
      text: "Hello\nWorld\tTab\u0000null",
      unicode: "日本語",
    });
    expect(result.text).toBe("Hello\nWorld\tTab\u0000null");
    expect(result.unicode).toBe("日本語");
  });

  test("large number of fields", () => {
    const input: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) {
      input[`field_${i}`] = i * 2;
    }
    const result = roundtrip(input);
    expect(Object.keys(result).length).toBe(100);
    for (let i = 0; i < 100; i++) {
      expect(result[`field_${i}`]).toBe(i * 2);
    }
  });
});
