import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "fs";

const TEST_DIR = "test/tmp";

interface TestDB {
  db: Database;
  path: string;
}

export function createTestDB(name = "test"): TestDB {
  try {
    mkdirSync(TEST_DIR, { recursive: true });
  } catch {
    // directory already exists
  }

  const path = `${TEST_DIR}/${name}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.db`;

  const db = new Database(path);
  db.run("PRAGMA journal_mode=WAL");
  db.run("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT)");
  db.run("CREATE TABLE IF NOT EXISTS counters (id INTEGER PRIMARY KEY, total INTEGER NOT NULL DEFAULT 0)");
  db.run("INSERT INTO counters (id, total) VALUES (1, 0)");

  return { db, path };
}

export function cleanupTestDB(testDB: TestDB): void {
  try {
    testDB.db.close();
  } catch {
    // already closed
  }

  try {
    rmSync(testDB.path, { force: true });
  } catch {
    // file already deleted
  }
}

export function getTestDBPath(name = "test"): string {
  try {
    mkdirSync(TEST_DIR, { recursive: true });
  } catch {
    // directory already exists
  }

  return `${TEST_DIR}/${name}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.db`;
}

export { TEST_DIR };
