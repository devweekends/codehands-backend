import { randomUUID } from "node:crypto";
import { openDb } from "./db.js";
import { canTransition } from "../../codehands-contracts/src/session.ts";
import type { SessionStatus } from "../../codehands-contracts/src/session.ts";

const db = openDb();
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

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

function event(sessionId: string, type: string, payload: object = {}) {
  const row = db.prepare(
    "select coalesce(max(seq), 0) + 1 as seq from events where session_id = ?"
  ).get(sessionId) as { seq: number };

  db.prepare(
    "insert into events (session_id, seq, type, payload) values (?, ?, ?, ?)"
  ).run(sessionId, row.seq, type, JSON.stringify(payload));
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

  event(sessionId, "session.status_changed", {
    from,
    to,
    reason
  });
}

function claimTasks() {
  const tasks = db.prepare(
    `select t.id, t.project_id, t.agent, t.models
     from tasks t
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
        event(sessionId, "task.claimed", {
          taskId: task.id
        });
        console.log("Claimed task:", task.id.slice(0, 8));
      }
    })();
  }
}

function processCommands() {
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
    db.transaction(() => {
      const existing = db.prepare(
        "select command_id from command_receipts where command_id = ?"
      ).get(command.id);

      if (existing) return;

      let outcome: "done" | "refused" = "refused";
      let reason: string | null = null;

      const session = command.session_id
        ? db.prepare(
            "select id, status from sessions where id = ?"
          ).get(command.session_id) as Session | undefined
        : undefined;

      if (!session) {
        reason = "Session not found or missing";
      } else if (command.kind === "approve" ||
                 command.kind === "reject") {
        const next: SessionStatus =
          command.kind === "approve" ? "approved" : "rejected";

        if (canTransition(session.status, next)) {
          transition(session.id, session.status, next);
          outcome = "done";
        } else {
          reason = `Cannot ${command.kind} from ${session.status}`;
        }
      } else {
        reason = `${command.kind} requires runner integration`;
      }

      db.prepare(
        `insert into command_receipts
         (command_id, outcome, reason)
         values (?, ?, ?)`
      ).run(command.id, outcome, reason);

      console.log("Command:", command.kind, outcome, reason ?? "");
    })();
  }
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
      processCommands();
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
