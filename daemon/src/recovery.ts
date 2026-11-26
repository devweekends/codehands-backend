// What the daemon does after a restart. The rules live here; watcher.ts applies
// them to the database.
import { basename, dirname, join, resolve } from "node:path";
import type { SessionStatus } from "../../../codehands-contracts/src/session.ts";

// Where the real runner keeps its session files for one database.
// recover() acts on every file in that folder, so two databases must never
// share one: the daemon lock only protects a single database.
export function runnerSessionFolder(databaseFile: string): string {
  const file = resolve(databaseFile);
  // state.db keeps the runner's usual folder name. For ~/.codehands/state.db
  // that is the runner's default, so sessions saved earlier are still found.
  // A database with any other name gets a folder of its own.
  return basename(file) === "state.db"
    ? join(dirname(file), "sessions")
    : `${file}.sessions`;
}

export type RecoveryAction =
  | { kind: "unchanged" }
  | { kind: "move"; to: SessionStatus; reason: string | null }
  | { kind: "warn"; message: string };

const move = (to: SessionStatus, reason: string | null = null): RecoveryAction =>
  ({ kind: "move", to, reason });

// database: what state.db says. runner: what the runner says after recover(),
// or undefined when it has no record of the session.
export function decideRecovery(
  database: SessionStatus,
  runner: SessionStatus | undefined
): RecoveryAction {
  if (database === "running") {
    if (runner === "stopped") {
      return move("stopped", "The daemon restarted. Press Resume to continue.");
    }
    if (runner === "awaiting_approval") return move("awaiting_approval");
    if (runner === "failed" || runner === undefined) {
      return move("failed", "Daemon restarted while session was running");
    }
  }

  if (database === "stopped" || database === "awaiting_approval") {
    if (runner === database) return { kind: "unchanged" };
    if (runner === "failed") {
      return move("failed", "The runner reports this session as failed");
    }
  }

  // The runner finished Approve or Reject, but the daemon never saved it.
  if (
    database === "awaiting_approval" &&
    (runner === "approved" || runner === "rejected")
  ) {
    return move(runner);
  }

  // Anything else is unexpected. A missing record may only mean a wrong or
  // deleted folder, and "failed" cannot be undone, so change nothing.
  return {
    kind: "warn",
    message: `database says ${database}, runner says ${runner ?? "nothing"}. Left unchanged.`,
  };
}
