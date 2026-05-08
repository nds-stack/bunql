import { describe, test, expect } from "bun:test";
import { RetryPolicy } from "../src/retry-policy.ts";
import { BusyError } from "../src/errors/busy-error.ts";

describe("RetryPolicy", () => {
  test("executes function successfully on first attempt", async () => {
    const policy = new RetryPolicy();
    const result = await policy.execute(async () => "success");
    expect(result).toBe("success");
  });

  test("retries on SQLITE_BUSY and succeeds", async () => {
    const policy = new RetryPolicy({ maxRetries: 3, baseDelay: 1, maxDelay: 5, jitter: false });
    let attempts = 0;

    const result = await policy.execute(async () => {
      attempts++;
      if (attempts < 3) {
        const error = new Error("database is locked");
        throw error;
      }
      return "success";
    });

    expect(result).toBe("success");
    expect(attempts).toBe(3);
  });

  test("throws BusyError after exhausting retries", async () => {
    const policy = new RetryPolicy({ maxRetries: 2, baseDelay: 1, maxDelay: 5, jitter: false });

    await expect(
      policy.execute(async () => {
        throw new Error("database is locked");
      })
    ).rejects.toThrow(BusyError);
  });

  test("BusyError preserves original error as cause", async () => {
    const policy = new RetryPolicy({ maxRetries: 2, baseDelay: 1, maxDelay: 5, jitter: false });

    try {
      await policy.execute(async () => {
        throw new Error("database is locked");
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BusyError);
      expect((e as BusyError).cause).toBeDefined();
      expect(((e as BusyError).cause as Error).message).toBe("database is locked");
    }
  });

  test("does not retry non-busy errors", async () => {
    const policy = new RetryPolicy({ maxRetries: 3, baseDelay: 1, maxDelay: 5, jitter: false });
    let attempts = 0;

    await expect(
      policy.execute(async () => {
        attempts++;
        throw new Error("SQLITE_ERROR: syntax error");
      })
    ).rejects.toThrow("syntax error");

    expect(attempts).toBe(1);
  });

  test("getDelay returns increasing delays", () => {
    const policy = new RetryPolicy({ baseDelay: 10, maxDelay: 100, jitter: false });

    const d1 = policy.getDelay(0);
    const d2 = policy.getDelay(1);
    const d3 = policy.getDelay(2);
    const d4 = policy.getDelay(3);

    expect(d1).toBe(10);   // 10 * 2^0 = 10
    expect(d2).toBe(20);   // 10 * 2^1 = 20
    expect(d3).toBe(40);   // 10 * 2^2 = 40
    expect(d4).toBe(80);   // 10 * 2^3 = 80
  });

  test("getDelay caps at maxDelay", () => {
    const policy = new RetryPolicy({ baseDelay: 10, maxDelay: 50, jitter: false });

    const d1 = policy.getDelay(2);   // 40
    const d2 = policy.getDelay(3);   // 80 -> capped to 50
    const d3 = policy.getDelay(10);  // very large -> capped to 50

    expect(d1).toBe(40);
    expect(d2).toBe(50);
    expect(d3).toBe(50);
  });

  test("getDelay with jitter returns randomized delays", () => {
    const policy = new RetryPolicy({ baseDelay: 100, maxDelay: 1000, jitter: true });

    const delays = Array.from({ length: 10 }, () => policy.getDelay(2));
    // Without jitter: 100 * 4 = 400
    // With jitter: Random between 200 and 400
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(200);
      expect(d).toBeLessThanOrEqual(400);
    }

    // Verify they're not all the same (jitter is active)
    const uniqueDelays = new Set(delays);
    expect(uniqueDelays.size).toBeGreaterThan(1);
  });

  test("isBusyError detects SQLITE_BUSY via errno", () => {
    const policy = new RetryPolicy();

    // Simulate Bun SQLiteError with errno
    const makeBusyError = (errno: number) => {
      const e = new Error("database is locked");
      Object.defineProperty(e, "errno", { value: errno, enumerable: true });
      return e;
    };

    expect(policy.isBusyError(makeBusyError(5))).toBe(true);   // SQLITE_BUSY
    expect(policy.isBusyError(makeBusyError(517))).toBe(true); // SQLITE_BUSY_SNAPSHOT
    expect(policy.isBusyError(makeBusyError(1))).toBe(false);  // SQLITE_ERROR
    expect(policy.isBusyError(makeBusyError(19))).toBe(false); // SQLITE_CONSTRAINT

    // Fallback to message-based detection for non-errno errors
    expect(policy.isBusyError(new Error("database is locked"))).toBe(true);
    expect(policy.isBusyError(new Error("SQLITE_BUSY"))).toBe(false); // no errno, no msg match
    expect(policy.isBusyError(new Error("some other error"))).toBe(false);
    expect(policy.isBusyError(null)).toBe(false);
    expect(policy.isBusyError("string")).toBe(false);
  });

  test("shouldRetry returns correct values", () => {
    const policy = new RetryPolicy({ maxRetries: 3 });

    expect(policy.shouldRetry(0)).toBe(true);
    expect(policy.shouldRetry(1)).toBe(true);
    expect(policy.shouldRetry(2)).toBe(true);
    expect(policy.shouldRetry(3)).toBe(false);
    expect(policy.shouldRetry(10)).toBe(false);
  });

  test("onBusy callback is called on each retry", async () => {
    const policy = new RetryPolicy({ maxRetries: 2, baseDelay: 1, maxDelay: 5, jitter: false });
    const calls: { attempt: number; delay: number }[] = [];

    policy.onBusy = (attempt, delay) => {
      calls.push({ attempt, delay });
    };

    try {
      await policy.execute(async () => {
        throw new Error("database is locked");
      });
    } catch {
      // expected to fail
    }

    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  test("onRetry callback is called on each retry", async () => {
    const policy = new RetryPolicy({ maxRetries: 1, baseDelay: 1, maxDelay: 5, jitter: false });
    const calls: { attempt: number; delay: number }[] = [];

    policy.onRetry = (attempt, delay) => {
      calls.push({ attempt, delay });
    };

    try {
      await policy.execute(async () => {
        throw new Error("database is locked");
      });
    } catch {
      // expected to fail
    }

    expect(calls.length).toBe(1);
  });
});
