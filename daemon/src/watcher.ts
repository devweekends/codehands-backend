import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { openDb } from "./db.js";
import { canTransition, type SessionStatus } from "../../../codehands-contracts/src/session.ts";
import type { RunnerEvent } from "../../../codehands-contracts/src/runner.ts";
import { createFakeRunner, createRunner } from "../../../codehands-agent/runner/src/index.ts";

const db = openDb();
const useFakeRunner = process.env.CODEHANDS_FAKE === "true";
const runner = useFakeRunner ? createFakeRunner() : createRunner();
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

type Task = {
  id: string;
  project_id: string;
  prompt: string;
  repo_path: string;
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

const activeRuns = new Set<string>();

function event(sessionId: string, type: string, payload: object = {}, seq?: number) {
  const row = db.prepare(
    "select coalesce(max(seq), 0) + 1 as seq from events where session_id = ?"
  ).get(sessionId) as { seq: number };

  db.prepare(
    "insert into events (session_id, seq, type, payload) values (?, ?, ?, ?)"
  ).run(sessionId, seq ?? row.seq, type, JSON.stringify(payload));
}

function transition(
  sessionId: string,
  from: SessionStatus,
  to: SessionStatus,
  reason: string | null = null
) {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal transition: ${from} -> ${to}`);
  }

  const result = db.prepare(
    `update sessions
     set status = ?, reason = ?, updated_at = ${NOW}
     where id = ? and status = ?`
  ).run(to, reason, sessionId, from);

  if (result.changes !== 1) {
    throw new Error("Session status changed concurrently");
  }
}

function setStatus(sessionId: string, to: SessionStatus, reason: string | null = null) {
  const session = db.prepare("select id, status from sessions where id = ?").get(sessionId) as Session | undefined;
  if (!session || session.status === to) return;
  transition(sessionId, session.status, to, reason);
}

async function persistRunnerEvent(runnerEvent: RunnerEvent) {
  const { sessionId, type, payload, seq } = runnerEvent;
  event(sessionId, type, payload, seq);
  if (type === "task.started") setStatus(sessionId, "running");
  if (type === "approval.requested") {
    setStatus(sessionId, "awaiting_approval");
    const diff = await runner.diff(sessionId);
    db.prepare(`update sessions set diff = ?, updated_at = ${NOW} where id = ?`)
      .run(diff.patch, sessionId);
  }
  if (type === "task.failed") {
    const reason = String(payload.reason ?? payload.result ?? "Runner failed");
    setStatus(sessionId, "failed", reason);
  }
  if (type === "task.stopped") setStatus(sessionId, "stopped");
  if (type === "task.finished" && typeof payload.costUsd === "number") {
    db.prepare(`update sessions set cost_usd = ?, updated_at = ${NOW} where id = ?`)
      .run(payload.costUsd, sessionId);
  }
}

async function runSession(task: Task, sessionId: string, resumePrompt?: string) {
  if (activeRuns.has(sessionId)) return;
  activeRuns.add(sessionId);
  try {
    if (task.agent !== "claude-code" && task.agent !== "codex") {
      throw new Error(`The runner does not support ${task.agent} yet.`);
    }
    if (task.agent === "codex") {
      throw new Error("Codex runner support is not available yet; choose Claude Code.");
    }
    const cliCheck = spawnSync("claude", ["--version"], { encoding: "utf8", windowsHide: true });
    if (cliCheck.error?.code === "ENOENT") {
      throw new Error("Claude Code CLI was not found on PATH. Install Claude Code, sign in with `claude`, and restart Code Hands.");
    }
    const models = JSON.parse(task.models || "{}") as Record<string, string>;
    const model = String(models.implement ?? Object.values(models)[0] ?? "sonnet");
    const stream = resumePrompt === undefined
      ? runner.start({
          sessionId,
          repoPath: task.repo_path,
          prompt: task.prompt,
          agent: "claude-code",
          model,
          budgetUsd: 0.5,
        })
      : runner.resume(sessionId, resumePrompt);
    for await (const runnerEvent of stream) await persistRunnerEvent(runnerEvent);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    setStatus(sessionId, "failed", reason);
    event(sessionId, "task.failed", { reason });
    console.error("Runner failed for session", sessionId, reason);
  } finally {
    activeRuns.delete(sessionId);
  }
}

function claimTasks() {
  const tasks = db.prepare(
    `select t.id, t.project_id, t.prompt, t.agent, t.models, p.path as repo_path
     from tasks t
     join projects p on p.id = t.project_id
     where not exists (
       select 1 from sessions s where s.task_id = t.id
     )
     order by t.created_at`
  ).all() as Task[];

  for (const task of tasks) {
    db.transaction(() => {
      const models = JSON.parse(task.models || "{}");
      const model =
        models.implement ??
        Object.values(models)[0] ??
        "unspecified";

      const sessionId = randomUUID();

      const result = db.prepare(
        `insert or ignore into sessions
         (id, task_id, project_id, agent, model, status)
         values (?, ?, ?, ?, ?, 'queued')`
      ).run(
        sessionId,
        task.id,
        task.project_id,
        task.agent,
        String(model)
      );

      if (result.changes === 1) {
        console.log("Claimed task:", task.id.slice(0, 8));
        void runSession(task, sessionId);
      }
    })();
  }

  // Queued rows can survive a daemon restart before the runner was launched.
  const queued = db.prepare(
    `select s.id as session_id, t.id, t.project_id, t.prompt, t.agent, t.models, p.path as repo_path
     from sessions s join tasks t on t.id = s.task_id
     join projects p on p.id = t.project_id where s.status = 'queued'`
  ).all() as (Task & { session_id: string })[];
  for (const task of queued) void runSession(task, task.session_id);
}

async function processCommands() {
  const commands = db.prepare(
    `select c.id, c.session_id, c.kind
     from commands c
     where not exists (
       select 1 from command_receipts r
       where r.command_id = c.id
     )
     order by c.created_at`
  ).all() as Command[];

  for (const command of commands) {
    const existing = db.prepare(
      "select command_id from command_receipts where command_id = ?"
    ).get(command.id);
    if (existing) continue;

    let outcome: "done" | "refused" = "refused";
    let reason: string | null = null;
    const session = command.session_id
      ? db.prepare("select id, status from sessions where id = ?").get(command.session_id) as Session | undefined
      : undefined;

    if (!session) {
      reason = "Session not found or missing";
    } else if (command.kind === "approve" || command.kind === "reject") {
      const next: SessionStatus = command.kind === "approve" ? "approved" : "rejected";
      if (!canTransition(session.status, next)) {
        reason = `Cannot ${command.kind} from ${session.status}`;
      } else {
        try {
          if (command.kind === "approve") {
            const { branch, commit } = await runner.approve(session.id, "");
            db.prepare(`update sessions set branch = ?, updated_at = ${NOW} where id = ?`)
              .run(branch, session.id);
            event(session.id, "session.approved", { branch, commit });
          } else {
            await runner.reject(session.id);
            event(session.id, "task.rejected");
          }
          setStatus(session.id, next);
          outcome = "done";
        } catch (error) {
          reason = error instanceof Error ? error.message : String(error);
          if (reason.includes("unknown session")) {
            setStatus(session.id, next, reason);
            event(session.id, command.kind === "approve" ? "session.approved" : "task.rejected", { orphan: true });
            outcome = "done";
            reason = null;
          }
        }
      }
    } else if (command.kind === "stop") {
      if (session.status !== "running" || !activeRuns.has(session.id)) {
        reason = `Cannot stop a session while it is ${session.status}`;
      } else {
        try {
          await runner.stop(session.id);
          outcome = "done";
        } catch (error) {
          reason = error instanceof Error ? error.message : String(error);
        }
      }
    } else if (command.kind === "resume") {
      if (session.status !== "stopped") {
        reason = `Cannot resume a session while it is ${session.status}`;
      } else {
        const task = loadTaskForSession(session.id);
        if (!task) reason = "Task details are missing";
        else {
          setStatus(session.id, "running");
          void runSession(task, session.id, "Continue the previous task.");
          outcome = "done";
        }
      }
    } else {
      reason = `Unsupported command: ${command.kind}`;
    }

    db.prepare(
      `insert into command_receipts
       (command_id, outcome, reason)
       values (?, ?, ?)`
    ).run(command.id, outcome, reason);
    console.log("Command:", command.kind, outcome, reason ?? "");
  }
}

function loadTaskForSession(sessionId: string): Task | undefined {
  return db.prepare(
    `select t.id, t.project_id, t.prompt, t.agent, t.models, p.path as repo_path
     from sessions s join tasks t on t.id = s.task_id
     join projects p on p.id = t.project_id where s.id = ?`
  ).get(sessionId) as Task | undefined;
}

function recoverSessions() {
  db.transaction(() => {
    const sessions = db.prepare(
      "select id, status from sessions where status = 'running'"
    ).all() as Session[];

    for (const session of sessions) {
      transition(
        session.id,
        session.status,
        "failed",
        "Daemon restarted while session was running"
      );
      console.log("Recovered interrupted session:", session.id);
    }
  })();
}

async function main() {
  console.log("CodeHands watcher starting...");
  recoverSessions();

  console.log("Watching SQLite database every 500ms");

  while (true) {
    try {
      claimTasks();
      await processCommands();
    } catch (err) {
      console.error("Watcher error:", err);
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

try {
  await main();
} finally {
  db.close();
}
