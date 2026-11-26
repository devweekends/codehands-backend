import { DatabaseSync } from "node:sqlite";
import { dbPath } from "./db.js";

// SQLite's result code for "another connection holds the lock".
const SQLITE_BUSY = 5;

// Kept for the whole life of the process. If this connection were closed or
// garbage-collected, the lock would be released.
let heldLock: DatabaseSync | undefined;

// Only one daemon may work on a database. A second one would mark the first
// one's running sessions as failed when it starts, and both could carry out the
// same command before either had saved its receipt.
//
// The lock is an exclusive transaction on a small file next to the database,
// opened and never committed. The operating system frees it when the process
// ends, even after a crash or a forced kill, so no stale lock is left behind.
//
// Returns false when another daemon holds the lock. Any other problem throws.
export function acquireDaemonLock(): boolean {
  if (heldLock) return true;

  const lock = new DatabaseSync(`${dbPath()}.daemon-lock`);
  try {
    lock.exec("PRAGMA busy_timeout = 0"); // answer at once, don't wait
    lock.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    lock.close();
    const code = (error as { errcode?: number }).errcode ?? 0;
    if ((code & 0xff) === SQLITE_BUSY) return false;
    throw error;
  }

  heldLock = lock;
  return true;
}
