import type { BunQLState } from "./bunql-state.ts";
import { ConnectionError } from "./errors/connection-error.ts";

export async function closeBunQL(s: BunQLState): Promise<void> {
  if (s.closed) return;
  (s as any).closed = true;

  if (s.maintenanceTimer) {
    clearInterval(s.maintenanceTimer);
    s.maintenanceTimer = null;
  }

  s.writeQueue.close();
  s.writeQueue.clearPending("Database is closing");

  try { await s.writeQueue.drain(); } catch { /* drain completed or timed out */ }

  s.statementCache.clear();
  s.readerPool?.close();

  try {
    s.db.close();
    s.log("info", "Database closed");
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    s.onError?.(err);
    throw new ConnectionError("Failed to close database", { cause: err });
  }
}
