import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function dbPath(): string {
  return process.env.CODEHANDS_DB ?? join(homedir(), ".codehands", "state.db");
}

export function openDb() {
  const file = dbPath();
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout = 5000"); // first, so the next two wait if the file is busy
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

// How many transactions are currently open on each connection.
const openTransactions = new WeakMap<DatabaseSync, number>();

// Runs `work` so that all of its writes are saved, or none of them.
// node:sqlite has no helper for this. A call made inside another call uses a
// savepoint, because SQLite does not allow a second BEGIN.
// `work` must be synchronous: an async function would still be running at COMMIT.
export function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  const depth = openTransactions.get(db) ?? 0;
  const savepoint = `nested_${depth}`;

  // IMMEDIATE takes the write lock now, so a busy database makes us wait here
  // instead of failing halfway through.
  db.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
  openTransactions.set(db, depth + 1);

  try {
    const result = work();
    if (result instanceof Promise) {
      throw new Error("inTransaction() cannot run an async function");
    }
    db.exec(depth === 0 ? "COMMIT" : `RELEASE ${savepoint}`);
    return result;
  } catch (error) {
    // SQLite may have rolled back already. Never let that hide the real error.
    if (db.isTransaction !== false) {
      try {
        db.exec(
          depth === 0
            ? "ROLLBACK"
            : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`
        );
      } catch (rollbackError) {
        console.error("Rollback failed:", rollbackError);
      }
    }
    throw error;
  } finally {
    openTransactions.set(db, depth);
  }
}
