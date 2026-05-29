import type { BunQLState } from "./bunql-state.ts";
import type { CheckpointMode, CheckpointResult, WalStatus, BackupResult, VacuumResult } from "./types/index.ts";

export const maintenanceOps = {
  async checkpoint(s: BunQLState, mode: CheckpointMode = "PASSIVE"): Promise<CheckpointResult> {
    s.ensureOpen();
    return s.retryPolicy.execute(async () =>
      s.writeQueue.enqueue(async () => {
        const r = checkpointDirect(s, mode);
        return { pagesCheckpointed: r.pagesCheckpointed, walSizeBytes: r.walSizeBytes };
      })
    );
  },

  async walStatus(s: BunQLState): Promise<WalStatus> {
    s.ensureOpen();
    return s.writeQueue.enqueue(async () => {
      const pageSize = s.pageSize;
      const pageCount = (s.db.prepare("PRAGMA page_count").get() as Record<string, number>)?.["page_count"] ?? 0;
      const row = s.db.prepare("PRAGMA wal_checkpoint(0)").get() as Record<string, number>;
      return {
        walSizePages: row?.[1] ?? 0, pageSize, pageCount,
        checkpointRequired: (row?.[1] ?? 0) > 100,
        lastCheckpointPages: row?.[2] ?? 0,
      };
    });
  },

  async backup(s: BunQLState, path: string): Promise<BackupResult> {
    s.ensureOpen();
    validateBackupPath(path);
    const start = performance.now();
    await s.retryPolicy.execute(async () =>
      s.writeQueue.enqueue(async () => {
        s.db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
      })
    );
    const file = Bun.file(path);
    return { size: file.size ?? 0, durationMs: performance.now() - start };
  },

  async vacuum(s: BunQLState, options?: { incremental?: boolean; pagesPerStep?: number }): Promise<VacuumResult> {
    s.ensureOpen();
    const start = performance.now();
    const startCount = (s.db.prepare("PRAGMA freelist_count").get() as Record<string, number>)?.["freelist_count"] ?? 0;
    await s.retryPolicy.execute(async () =>
      s.writeQueue.enqueue(async () => {
        if (options?.incremental) {
          s.db.exec(`PRAGMA incremental_vacuum(${options.pagesPerStep ?? 100})`);
        } else {
          s.db.exec("VACUUM");
        }
      })
    );
    const endCount = (s.db.prepare("PRAGMA freelist_count").get() as Record<string, number>)?.["freelist_count"] ?? 0;
    return { pagesReclaimed: Math.max(0, startCount - endCount), durationMs: performance.now() - start };
  },
};

export function validateBackupPath(path: string): void {
  if (!path || path.length === 0) throw new Error("Backup path must not be empty.");
  if (path.length > 512) throw new Error(`Backup path too long (${path.length} chars, max 512).`);
  if (path.includes("..")) throw new Error(`Invalid backup path: ${path}. Path traversal (..) is not allowed.`);
  if (path.includes("\0")) throw new Error(`Invalid backup path: ${path}. Null byte not allowed.`);
  if (path.includes("\\")) throw new Error(`Invalid backup path: ${path}. Backslash not allowed — use forward slash.`);
  if (!/^[\w./_-]+$/.test(path) && !/^[a-zA-Z]:/.test(path)) {
    throw new Error(`Invalid backup path: ${path}. Only alphanumeric, /, ., _, - allowed.`);
  }
}

export function checkpointDirect(s: BunQLState, mode: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE" = "PASSIVE"): { pagesCheckpointed: number; walSizeBytes: number } {
  const modeMap = { PASSIVE: 0, FULL: 1, RESTART: 2, TRUNCATE: 3 };
  const row = s.db.prepare(`PRAGMA wal_checkpoint(${modeMap[mode]})`).get() as Record<string, number>;
  return {
    pagesCheckpointed: row?.[2] ?? 0,
    walSizeBytes: (row?.[1] ?? 0) * s.pageSize,
  };
}

export function startMaintenance(s: BunQLState): void {
  const maintenance = s.config.maintenance;
  if (!maintenance) return;
  const intervals: number[] = [];

  if (maintenance.checkpoint?.enabled) intervals.push(maintenance.checkpoint.intervalMs ?? 60000);
  if (maintenance.vacuum?.enabled) intervals.push(maintenance.vacuum.intervalMs ?? 60000);
  if (maintenance.backup?.enabled) intervals.push(maintenance.backup.intervalMs);
  if (maintenance.integrityCheck?.enabled) intervals.push(maintenance.integrityCheck.intervalMs);
  if (intervals.length === 0) return;

  const intervalMs = Math.min(...intervals);
  s.maintenanceTimer = setInterval(async () => {
    if (s.closed) return;
    try {
      await s.writeQueue.enqueue(async () => {
        if (maintenance.checkpoint?.enabled) {
          const status = checkpointDirect(s, "PASSIVE");
          if (status.walSizeBytes / (s.pageSize || 4096) > (maintenance.checkpoint.pagesThreshold ?? 1000)) {
            checkpointDirect(s, maintenance.checkpoint.mode ?? "TRUNCATE");
          }
        }
        if (maintenance.vacuum?.enabled) {
          const pages = maintenance.vacuum.pagesPerStep ?? 100;
          s.db.exec(maintenance.vacuum.mode === "full" ? "VACUUM" : `PRAGMA incremental_vacuum(${pages})`);
        }
        if (maintenance.backup?.enabled) {
          const ts = new Date().toISOString().replace(/[:.]/g, "-");
          const p = `${maintenance.backup.path.replace(/\/$/, "")}/bunql-backup-${ts}.db`;
          s.db.exec(`VACUUM INTO '${p.replace(/'/g, "''")}'`);
        }
      });
    } catch (error) {
      s.log("error", `Maintenance task failed: ${error}`);
    }
  }, intervalMs);
}
