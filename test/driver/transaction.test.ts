import { describe, test, expect } from "bun:test";
import { TransactionManager, type TransactionBackend } from "../../src/driver/transaction.ts";

class MockBackend implements TransactionBackend {
  log: string[] = [];
  async begin(): Promise<void> { this.log.push("BEGIN"); }
  async commit(): Promise<void> { this.log.push("COMMIT"); }
  async rollback(): Promise<void> { this.log.push("ROLLBACK"); }
  async savepoint(name: string): Promise<void> { this.log.push(`SAVEPOINT ${name}`); }
  async releaseSavepoint(name: string): Promise<void> { this.log.push(`RELEASE ${name}`); }
  async rollbackTo(name: string): Promise<void> { this.log.push(`ROLLBACK TO ${name}`); }
}

describe("TransactionManager", () => {
  test("begin/commit flow", async () => {
    const backend = new MockBackend();
    const tm = new TransactionManager(backend);
    await tm.begin();
    await tm.commit();
    expect(backend.log).toEqual(["BEGIN", "COMMIT"]);
  });

  test("begin/rollback flow", async () => {
    const backend = new MockBackend();
    const tm = new TransactionManager(backend);
    await tm.begin();
    await tm.rollback();
    expect(backend.log).toEqual(["BEGIN", "ROLLBACK"]);
  });

  test("nested savepoint", async () => {
    const backend = new MockBackend();
    const tm = new TransactionManager(backend);
    await tm.begin();
    await tm.begin(); // nested
    await tm.commit(); // inner
    await tm.commit(); // outer
    expect(backend.log).toEqual(["BEGIN", "SAVEPOINT sp_1", "RELEASE sp_1", "COMMIT"]);
  });

  test("nested rollback", async () => {
    const backend = new MockBackend();
    const tm = new TransactionManager(backend);
    await tm.begin();
    await tm.begin();
    await tm.rollback(); // inner rollback
    await tm.rollback(); // outer rollback
    expect(backend.log).toEqual(["BEGIN", "SAVEPOINT sp_1", "ROLLBACK TO sp_1", "ROLLBACK"]);
  });

  test("transaction callback commits on success", async () => {
    const backend = new MockBackend();
    const tm = new TransactionManager(backend);
    let ctxReceived = false;
    await tm.transaction(async (ctx) => {
      ctxReceived = true;
      expect(typeof ctx.savepoint).toBe("function");
      expect(typeof ctx.rollbackTo).toBe("function");
      return "ok";
    });
    expect(ctxReceived).toBe(true);
    expect(backend.log).toEqual(["BEGIN", "COMMIT"]);
  });

  test("transaction callback rolls back on error", async () => {
    const backend = new MockBackend();
    const tm = new TransactionManager(backend);
    try {
      await tm.transaction(async () => {
        throw new Error("test error");
      });
      expect.unreachable();
    } catch (e: unknown) {
      expect((e as Error).message).toBe("test error");
    }
    expect(backend.log).toEqual(["BEGIN", "ROLLBACK"]);
  });
});
