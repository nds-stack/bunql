import { describe, test, expect } from "bun:test";
import { WriteQueue } from "../src/write-queue.ts";

describe("WriteQueue", () => {
  test("enqueue executes operations in order", async () => {
    const queue = new WriteQueue();
    const results: number[] = [];

    const p1 = queue.enqueue(async () => {
      results.push(1);
      return 1;
    });

    const p2 = queue.enqueue(async () => {
      results.push(2);
      return 2;
    });

    const p3 = queue.enqueue(async () => {
      results.push(3);
      return 3;
    });

    expect(await p1).toBe(1);
    expect(await p2).toBe(2);
    expect(await p3).toBe(3);
    expect(results).toEqual([1, 2, 3]);
  });

  test("enqueue returns the value from the executed function", async () => {
    const queue = new WriteQueue();

    const result = await queue.enqueue(async () => "hello");
    expect(result).toBe("hello");
  });

  test("drain waits for all queued operations to complete", async () => {
    const queue = new WriteQueue();
    let completed = false;

    queue.enqueue(async () => {
      await Bun.sleep(10);
      completed = true;
      return "done";
    });

    await queue.drain();
    expect(completed).toBe(true);
  });

  test("drain resolves immediately when queue is empty and not processing", async () => {
    const queue = new WriteQueue();
    await queue.drain();
    // Should resolve without hanging
    expect(queue.size).toBe(0);
  });

  test("rejects enqueued operations when closed", async () => {
    const queue = new WriteQueue();
    queue.close();

    await expect(
      queue.enqueue(async () => "value"),
    ).rejects.toThrow("WriteQueue is closed");
  });

  test("processes items that were enqueued before close", async () => {
    const queue = new WriteQueue();
    const promise = queue.enqueue(async () => "done");

    queue.close();

    const result = await promise;
    expect(result).toBe("done");
  });

  test("size returns correct number of pending items", () => {
    const queue = new WriteQueue();

    expect(queue.size).toBe(0);

    queue.enqueue(async () => "a");
    queue.enqueue(async () => "b");
    queue.enqueue(async () => "c");

    expect(queue.size).toBe(3);
  });

  test("isProcessing reflects processing state", async () => {
    const queue = new WriteQueue();

    expect(queue.isProcessing).toBe(false);

    const promise = queue.enqueue(async () => {
      expect(queue.isProcessing).toBe(true);
      await Bun.sleep(5);
      return "done";
    });

    await promise;
    expect(queue.isProcessing).toBe(false);
  });

  test("handles errors in executed functions", async () => {
    const queue = new WriteQueue();

    const errorPromise = queue.enqueue(async () => {
      throw new Error("test error");
    });

    await expect(errorPromise).rejects.toThrow("test error");
  });

  test("continues processing after an error", async () => {
    const queue = new WriteQueue();

    const errorPromise = queue.enqueue(async () => {
      throw new Error("first error");
    });

    const successPromise = queue.enqueue(async () => "second success");

    await expect(errorPromise).rejects.toThrow("first error");
    expect(await successPromise).toBe("second success");
  });

  test("onDrain is called when queue becomes empty", async () => {
    const queue = new WriteQueue();
    let drained = false;

    queue.onDrain = () => {
      drained = true;
    };

    await queue.enqueue(async () => "item");
    expect(drained).toBe(true);
  });

  test("clearPending rejects all pending items", async () => {
    const queue = new WriteQueue();

    const p1 = queue.enqueue(async () => "a");
    const p2 = queue.enqueue(async () => "b");
    const p3 = queue.enqueue(async () => "c");

    expect(queue.size).toBe(3);

    queue.clearPending("shutting down");

    try {
      await p1;
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toBe("shutting down");
    }

    try {
      await p2;
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toBe("shutting down");
    }

    try {
      await p3;
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toBe("shutting down");
    }

    expect(queue.size).toBe(0);
  });

  test("handles concurrent enqueues correctly", async () => {
    const queue = new WriteQueue();
    const results: number[] = [];

    const promises = Array.from({ length: 20 }, (_, i) =>
      queue.enqueue(async () => {
        await Bun.sleep(1);
        results.push(i);
        return i;
      })
    );

    const values = await Promise.all(promises);
    expect(values).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(results).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });
});
