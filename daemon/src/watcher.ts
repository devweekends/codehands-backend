import { randomUUID } from "node:crypto";
import { dbPath, inTransaction, openDb } from "./db.js";
import { acquireDaemonLock } from "./lock.js";
import {
  canTransition,
  type SessionStatus,
} from "../../../codehands-contracts/src/session.ts";
import type {
  Runner,
  RunnerEvent,
} from "../../../codehands-contracts/src/runner.ts";
import {
  createFakeRunner,
  createRunner,
  type RecoverableRunner,
} from "../../../codehands-agent/runner/src/index.ts";
import {
  checkProvider,
  getActiveProviderLimit,
} from "./preflight.js";
import {
  decideRecovery,
  runnerSessionFolder,
  type RecoveryAction,
} from "./recovery.js";
import { buildStartOptions } from "./start-options.js";
import { saveRunnerEvent } from "./runner-events.js";

const db = openDb();
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

// CODEHANDS_FAKE=true selects the fake runner, otherwise the real one.
const fakeMode = process.env.CODEHANDS_FAKE === "true";
// Only the real runner saves its sessions, so only it can recover them.
const realRunner: RecoverableRunner | undefined = fakeMode
  ? undefined
  : createRunner({ sessionRoot: runnerSessionFolder(dbPath()) });
const runner: Runner = realRunner ?? createFakeRunner({ delayMs: 300 });

const activeRuns = new Set<string>();

type Agent = "codex" | "claude-code";

type Task = {
  id: string;
  project_id: string;
  agent: string;
  models: string;
};

type Session = {
  id: string;
  status: SessionStatus;
};

type Command = {
  id: string;
  session_id: string | null;
  kind: string;
};

function isSupportedAgent(agent: string): agent is Agent {
  return agent === "codex" || agent === "claude-code";
}

function event(
  sessionId: string,
  type: string,
  payload: object = {}
): void {
  const row = db.prepare(`
    SELECT COALESCE(MAX(seq), 0) + 1 AS seq
    FROM events
    WHERE session_id = ?
  `).get(sessionId) as { seq: number };

  db.prepare(`
    INSERT INTO events (session_id, seq, type, payload)
    VALUES (?, ?, ?, ?)
  `).run(
    sessionId,
    row.seq,
    type,
    JSON.stringify(payload)
  );
}

function getSession(sessionId: string): Session | undefined {
  return db.prepare(`
    SELECT id, status
    FROM sessions
    WHERE id = ?
  `).get(sessionId) as Session | undefined;
}

function transition(
  sessionId: string,
  from: SessionStatus,
  to: SessionStatus,
  reason: string | null = null
): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal transition: ${from} -> ${to}`);
  }

  // The new status and its history event are saved together, or not at
  // all. A crash between two separate saves would leave them disagreeing.
  // claimTasks() and recoverSessions() call this inside their own
  // transaction. inTransaction() then uses a savepoint, so nesting is safe.
  inTransaction(db, () => {
    const result = db.prepare(`
      UPDATE sessions
      SET status = ?,
          reason = ?,
          updated_at = ${NOW}
      WHERE id = ?
        AND status = ?
    `).run(to, reason, sessionId, from);

    if (result.changes !== 1) {
      throw new Error(
        `Session status changed concurrently: ${sessionId}`
      );
    }

    event(sessionId, "session.status_changed", {
      from,
      to,
      reason,
    });
  });
}

function transitionIfAllowed(
  sessionId: string,
  to: SessionStatus,
  reason: string | null = null
): boolean {
  const session = getSession(sessionId);

  if (!session || !canTransition(session.status, to)) {
    return false;
  }

  transition(sessionId, session.status, to, reason);
  return true;
}

// Contract v0.2.0 provider states -> states allowed by provider_status.
function providerStateToDb(state: unknown): string | null {
  switch (state) {
    case "rate_limited":
      return "rate_limited";
    case "usage_limit":
    case "subscription_inactive":
      return "usage_limited";
    case "auth_expired":
      return "not_logged_in";
    case "down":
      return "outage";
    default:
      return null;
  }
}

async function consumeRunnerEvents(
  sessionId: string,
  stream: AsyncIterable<RunnerEvent>
): Promise<void> {
  for await (const runnerEvent of stream) {
    if (runnerEvent.sessionId !== sessionId) {
      throw new Error(
        `Runner event session mismatch: ${runnerEvent.sessionId}`
      );
    }

    const dbSeq = saveRunnerEvent(runnerEvent);

    console.log(
      "Runner event:",
      sessionId.slice(0, 8),
      runnerEvent.type,
      "DB seq:",
      dbSeq
    );

    if (runnerEvent.type === "provider.status") {
      // Contract v0.2.0: { state, message, code?, retryAt? }.
      // The payload has no agent, so take it from the session.
      const payload = runnerEvent.payload;
      const state = providerStateToDb(payload.state);
      const session = db.prepare(`
        SELECT agent FROM sessions WHERE id = ?
      `).get(sessionId) as { agent: string } | undefined;

      if (state && session && isSupportedAgent(session.agent)) {
        db.prepare(`
          INSERT INTO provider_status (
            agent, state, reason, retry_at, checked_at
          )
          VALUES (?, ?, ?, ?, ${NOW})
          ON CONFLICT(agent) DO UPDATE SET
            state = excluded.state,
            reason = excluded.reason,
            retry_at = excluded.retry_at,
            checked_at = excluded.checked_at
        `).run(
          session.agent,
          state,
          typeof payload.message === "string" ? payload.message : null,
          typeof payload.retryAt === "string" ? payload.retryAt : null
        );
      }
    }

    if (runnerEvent.type === "approval.requested") {
      const changed = transitionIfAllowed(sessionId, "awaiting_approval");
      console.log("Approval transition:", changed ? "SUCCESS" : "FAILED", sessionId);
    }

    if (runnerEvent.type === "task.failed") {
      const reason = typeof runnerEvent.payload.reason === "string"
        ? runnerEvent.payload.reason
        : "Runner failed";
      transitionIfAllowed(sessionId, "failed", reason);
    }

    if (runnerEvent.type === "task.stopped") {
      transitionIfAllowed(sessionId, "stopped");
    }

    if (runnerEvent.type === "task.finished") {
      // The runner emits approval.requested after task.finished.
      // Keep the session running until the approval event arrives.
      console.log("Runner finished work; waiting for approval:", sessionId);
    }
  }
}

async function runSession(
  sessionId: string,
  resume = false
): Promise<void> {
  if (activeRuns.has(sessionId)) {
    console.log("Session already running:", sessionId);
    return;
  }

  activeRuns.add(sessionId);

  try {
    const stream = resume
      ? runner.resume(sessionId)
      : runner.start(buildStartOptions(sessionId));

    await consumeRunnerEvents(sessionId, stream);
  } catch (error) {
    console.error("Runner failed:", sessionId, error);

    const reason =
      error instanceof Error
        ? error.message
        : String(error);

    transitionIfAllowed(sessionId, "failed", reason);
  } finally {
    activeRuns.delete(sessionId);
  }
}

function claimTasks(): void {
  const tasks = db.prepare(`
    SELECT t.id, t.project_id, t.agent, t.models
    FROM tasks t
    WHERE NOT EXISTS (
      SELECT 1
      FROM sessions s
      WHERE s.task_id = t.id
    )
    ORDER BY t.created_at
  `).all() as Task[];

  for (const task of tasks) {
    try {
      let providerState: string;
      let providerReason: string | null = null;
      let retryAt: string | null = null;

      if (!isSupportedAgent(task.agent)) {
        providerState = "not_installed";
        providerReason = `Unsupported agent: ${task.agent}`;
      } else if (fakeMode) {
        providerState = "ok";
      } else {
        const activeLimit = getActiveProviderLimit(task.agent);

        if (activeLimit) {
          providerState = activeLimit.state;
          providerReason = activeLimit.reason;
          retryAt = activeLimit.retry_at;
        } else {
          const provider = checkProvider(task.agent);
          providerState = provider.state;
          providerReason = provider.reason;
          retryAt = provider.retry_at;
        }
      }

      const claimedSessionId = inTransaction(db, (): string | null => {
        if (isSupportedAgent(task.agent) && !fakeMode) {
          db.prepare(`
            INSERT INTO provider_status (
              agent, state, reason, retry_at, checked_at
            )
            VALUES (
              ?, ?, ?, ?,
              strftime('%Y-%m-%dT%H:%M:%fZ','now')
            )
            ON CONFLICT(agent) DO UPDATE SET
              state = excluded.state,
              reason = excluded.reason,
              retry_at = excluded.retry_at,
              checked_at = excluded.checked_at
          `).run(
            task.agent,
            providerState,
            providerReason,
            retryAt
          );
        }

        const models = JSON.parse(task.models || "{}") as
          Record<string, unknown>;

        const model =
          models.implement ??
          Object.values(models)[0] ??
          ""; // empty means unset (sessions.model is NOT NULL)

        const sessionId = randomUUID();

        const result = db.prepare(`
          INSERT OR IGNORE INTO sessions (
            id, task_id, project_id, agent, model, status
          )
          VALUES (?, ?, ?, ?, ?, 'queued')
        `).run(
          sessionId,
          task.id,
          task.project_id,
          task.agent,
          String(model)
        );

        if (result.changes !== 1) {
          return null;
        }

        event(sessionId, "task.claimed", {
          taskId: task.id,
        });

        console.log(
          "Claimed task:",
          task.id.slice(0, 8)
        );

        if (providerState !== "ok") {
          const reason =
            providerReason ??
            `Provider unavailable: ${providerState}`;

          transition(sessionId, "queued", "failed", reason);

          event(sessionId, "provider.preflight_refused", {
            agent: task.agent,
            state: providerState,
            reason,
            retry_at: retryAt,
          });

          console.log(
            "Preflight refused:",
            task.id.slice(0, 8),
            reason
          );

          return null;
        }

        event(sessionId, "provider.preflight_passed", {
          agent: task.agent,
          state: providerState,
        });

        console.log(
          "Preflight passed:",
          task.id.slice(0, 8)
        );

        // Part of the claim: a crash must not leave a claimed session in
        // "queued", because nothing would ever pick it up again.
        transition(sessionId, "queued", "running");

        return sessionId;
      });

      if (claimedSessionId) {
        // Start the runner only after the transaction has committed.
        void runSession(claimedSessionId);
      }
    } catch (error) {
      console.error(
        "Failed to claim task:",
        task.id,
        error
      );
    }
  }
}

function saveCommandReceipt(
  commandId: string,
  outcome: "done" | "refused",
  reason: string | null
): void {
  db.prepare(`
    INSERT OR IGNORE INTO command_receipts (
      command_id, outcome, reason
    )
    VALUES (?, ?, ?)
  `).run(commandId, outcome, reason);
}

async function processCommands(): Promise<void> {
  const commands = db.prepare(`
    SELECT c.id, c.session_id, c.kind
    FROM commands c
    WHERE NOT EXISTS (
      SELECT 1
      FROM command_receipts r
      WHERE r.command_id = c.id
    )
    ORDER BY c.created_at
  `).all() as Command[];

  for (const command of commands) {
    let outcome: "done" | "refused" = "refused";
    let reason: string | null = null;

    try {
      if (!command.session_id) {
        reason = "Session not found or missing";
      } else {
        const session = getSession(command.session_id);

        if (!session) {
          reason = "Session not found";
        } else {
          switch (command.kind) {
            case "stop": {
              if (session.status !== "running") {
                reason = `Cannot stop from ${session.status}`;
                break;
              }

              await runner.stop(session.id);
              transitionIfAllowed(session.id, "stopped");
              outcome = "done";
              break;
            }

            case "resume": {
              if (session.status !== "stopped") {
                reason = `Cannot resume from ${session.status}`;
                break;
              }

              if (activeRuns.has(session.id)) {
                reason = "Runner is still active";
                break;
              }

              transition(session.id, "stopped", "running");
              void runSession(session.id, true);
              outcome = "done";
              break;
            }

            case "approve": {
              if (!canTransition(session.status, "approved")) {
                reason =
                  `Cannot approve from ${session.status}`;
                break;
              }

              const result = await runner.approve(
                session.id,
                ""
              );

              db.prepare(`
                UPDATE sessions
                SET branch = ?,
                    updated_at = ${NOW}
                WHERE id = ?
              `).run(result.branch, session.id);

              transition(
                session.id,
                session.status,
                "approved"
              );

              outcome = "done";
              break;
            }

            case "reject": {
              if (!canTransition(session.status, "rejected")) {
                reason =
                  `Cannot reject from ${session.status}`;
                break;
              }

              await runner.reject(session.id);

              transition(
                session.id,
                session.status,
                "rejected"
              );

              outcome = "done";
              break;
            }

            default:
              reason =
                `Unsupported command: ${command.kind}`;
          }
        }
      }
    } catch (error) {
      reason =
        error instanceof Error
          ? error.message
          : String(error);

      console.error(
        "Command failed:",
        command.kind,
        error
      );
    }

    saveCommandReceipt(command.id, outcome, reason);

    console.log(
      "Command:",
      command.kind,
      outcome,
      reason ?? ""
    );
  }
}

// The runner finished this button before the restart. Close the command that
// is still waiting, or it would run again and be recorded as refused.
function closeFinishedCommands(
  sessionId: string,
  kind: "approve" | "reject"
): void {
  db.prepare(`
    INSERT OR IGNORE INTO command_receipts (command_id, outcome, reason)
    SELECT c.id, 'done', 'Finished before the daemon restarted'
    FROM commands c
    WHERE c.session_id = ?
      AND c.kind = ?
      AND NOT EXISTS (
        SELECT 1 FROM command_receipts r WHERE r.command_id = c.id
      )
  `).run(sessionId, kind);
}

function applyRecovery(session: Session, action: RecoveryAction): void {
  if (action.kind === "unchanged") return;

  if (action.kind === "warn") {
    console.warn("Recovery:", session.id, action.message);
    return;
  }

  // Status, history and receipts are saved together, or not at all.
  inTransaction(db, () => {
    transition(session.id, session.status, action.to, action.reason);

    if (action.to === "approved" || action.to === "rejected") {
      closeFinishedCommands(
        session.id,
        action.to === "approved" ? "approve" : "reject"
      );
    }
  });

  console.log(
    "Recovered session:",
    session.id,
    `${session.status} -> ${action.to}`
  );
}

// After a restart the database may be behind. The runner keeps its own record
// of each session, so ask it before changing anything. If we are stopped half
// way, running this again reaches the same result.
async function recoverSessions(): Promise<void> {
  if (realRunner) {
    // keep: an interrupted run becomes "stopped" and keeps its private copy,
    // so it can be resumed. Without keep, that copy is deleted.
    const report = await realRunner.recover({ keep: () => true });

    for (const problem of report.cleanupErrors) {
      console.error(
        "Runner could not clean up:",
        problem.sessionId,
        problem.reason
      );
    }
  }

  const sessions = db.prepare(`
    SELECT id, status
    FROM sessions
    WHERE status IN ('running', 'stopped', 'awaiting_approval')
  `).all() as Session[];

  for (const session of sessions) {
    // The fake runner saves nothing, so only its running sessions are lost.
    if (!realRunner && session.status !== "running") continue;

    applyRecovery(
      session,
      decideRecovery(session.status, realRunner?.status(session.id))
    );
  }
}

async function main(): Promise<void> {
  console.log("CodeHands watcher starting...");
  console.log(
    "Runner mode:",
    fakeMode ? "FAKE" : "REAL"
  );

  // Must come before anything that changes data: recovery marks running
  // sessions as failed, and the loop claims tasks and carries out commands.
  if (!acquireDaemonLock()) {
    console.error(
      `Another daemon is already running for ${dbPath()}. Exiting.`
    );
    process.exitCode = 1;
    return;
  }

  // Finishes before any task is claimed or any command is carried out. If the
  // runner cannot recover, the daemon stops here rather than guess.
  await recoverSessions();

  console.log("Watching SQLite database every 500ms");

  while (true) {
    try {
      claimTasks();
      await processCommands();
    } catch (error) {
      console.error("Watcher error:", error);
    }

    await new Promise<void>(resolve =>
      setTimeout(resolve, 500)
    );
  }
}

try {
  await main();
} finally {
  db.close();
}