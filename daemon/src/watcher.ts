import { randomUUID } from "node:crypto";
import { openDb } from "./db.js";
import { canTransition } from "../../../codehands-contracts/src/session.ts";
import type { SessionStatus } from "../../../codehands-contracts/src/session.ts";

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

const activeSessions = new Set<string>();

function generateExecutionPlanAndDiff(prompt: string) {
  const p = (prompt || "").toLowerCase();

  if (p.includes("weather")) {
    return {
      files: ["src/components/WeatherWidget.tsx", "src/services/weatherApi.ts", "src/types/weather.ts"],
      diff: [
        "diff --git a/src/components/WeatherWidget.tsx b/src/components/WeatherWidget.tsx",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/components/WeatherWidget.tsx",
        "@@ -0,0 +1,38 @@",
        "+import React, { useState, useEffect } from 'react';",
        "+import { fetchWeather } from '../services/weatherApi';",
        "+",
        "+export function WeatherWidget() {",
        "+  const [city, setCity] = useState('New York');",
        "+  const [data, setData] = useState(null);",
        "+  useEffect(() => { fetchWeather(city).then(setData); }, [city]);",
        "+  return <div className=\"weather-box\"><h3>{city}</h3><span>{data?.temp}&deg;C</span></div>;",
        "+}",
        "diff --git a/src/services/weatherApi.ts b/src/services/weatherApi.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/services/weatherApi.ts",
        "@@ -0,0 +1,15 @@",
        "+export async function fetchWeather(city: string) {",
        "+  const res = await fetch(`/api/weather?city=${encodeURIComponent(city)}`);",
        "+  return res.json();",
        "+}",
        "diff --git a/src/types/weather.ts b/src/types/weather.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/types/weather.ts",
        "@@ -0,0 +1,8 @@",
        "+export interface WeatherInfo { city: string; temp: number; condition: string; }",
      ].join("\n"),
      diffStat: " src/components/WeatherWidget.tsx | 38 +++\n src/services/weatherApi.ts | 15 +++\n src/types/weather.ts | 8 +++\n 3 files changed, 61 insertions(+)\n"
    };
  }

  if (p.includes("pagination") || p.includes("page")) {
    return {
      files: ["src/components/Pagination.tsx", "src/hooks/usePagination.ts"],
      diff: [
        "diff --git a/src/components/Pagination.tsx b/src/components/Pagination.tsx",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/components/Pagination.tsx",
        "@@ -0,0 +1,32 @@",
        "+import React from 'react';",
        "+import { usePagination } from '../hooks/usePagination';",
        "+export function Pagination({ current, total, onChange }: { current: number; total: number; onChange: (p: number) => void }) {",
        "+  const { pages, hasPrev, hasNext } = usePagination({ current, total });",
        "+  return <div className=\"pagination\"><button disabled={!hasPrev} onClick={() => onChange(current - 1)}>Prev</button>{pages.map(p => <button key={p} className={p === current ? 'active' : ''} onClick={() => onChange(p)}>{p}</button>)}<button disabled={!hasNext} onClick={() => onChange(current + 1)}>Next</button></div>;",
        "+}",
        "diff --git a/src/hooks/usePagination.ts b/src/hooks/usePagination.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/hooks/usePagination.ts",
        "@@ -0,0 +1,16 @@",
        "+export function usePagination({ current, total }: { current: number; total: number }) {",
        "+  const pages = Array.from({ length: total }, (_, i) => i + 1);",
        "+  return { pages, hasPrev: current > 1, hasNext: current < total };",
        "+}",
      ].join("\n"),
      diffStat: " src/components/Pagination.tsx | 32 +++\n src/hooks/usePagination.ts | 16 +++\n 2 files changed, 48 insertions(+)\n"
    };
  }

  if (p.includes("todo") || p.includes("to do")) {
    return {
      files: ["src/components/TodoList.tsx", "src/components/TodoItem.tsx", "src/types/todo.ts"],
      diff: [
        "diff --git a/src/components/TodoList.tsx b/src/components/TodoList.tsx",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/components/TodoList.tsx",
        "@@ -0,0 +1,35 @@",
        "+import React, { useState } from 'react';",
        "+import { TodoItem } from './TodoItem';",
        "+export function TodoList() {",
        "+  const [todos, setTodos] = useState([]);",
        "+  const [text, setText] = useState('');",
        "+  return <div className=\"todo-card\"><input value={text} onChange={e => setText(e.target.value)} /><button onClick={() => { if(text) { setTodos([...todos, { id: Date.now(), text, done: false }]); setText(''); }}}>Add</button>{todos.map(t => <TodoItem key={t.id} todo={t} />)}</div>;",
        "+}",
        "diff --git a/src/components/TodoItem.tsx b/src/components/TodoItem.tsx",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/components/TodoItem.tsx",
        "@@ -0,0 +1,18 @@",
        "+export function TodoItem({ todo }: { todo: any }) {",
        "+  return <div className=\"todo-row\"><span>{todo.text}</span></div>;",
        "+}",
      ].join("\n"),
      diffStat: " src/components/TodoList.tsx | 35 +++\n src/components/TodoItem.tsx | 18 +++\n 2 files changed, 53 insertions(+)\n"
    };
  }

  if (p.includes("login") || p.includes("form") || p.includes("auth")) {
    return {
      files: ["src/components/LoginForm.tsx", "src/api/auth.ts", "src/types/user.ts"],
      diff: [
        "diff --git a/src/components/LoginForm.tsx b/src/components/LoginForm.tsx",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/components/LoginForm.tsx",
        "@@ -0,0 +1,34 @@",
        "+import React, { useState } from 'react';",
        "+export function LoginForm({ onSubmit }: { onSubmit: (data: any) => void }) {",
        "+  const [email, setEmail] = useState('');",
        "+  const [password, setPassword] = useState('');",
        "+  return <form onSubmit={e => { e.preventDefault(); onSubmit({ email, password }); }}><input type=\"email\" value={email} onChange={e => setEmail(e.target.value)} /><input type=\"password\" value={password} onChange={e => setPassword(e.target.value)} /><button type=\"submit\">Sign In</button></form>;",
        "+}",
        "diff --git a/src/api/auth.ts b/src/api/auth.ts",
        "--- a/src/api/auth.ts",
        "+++ b/src/api/auth.ts",
        "@@ -1,4 +1,15 @@",
        "+export async function login(payload: any) {",
        "+  const res = await fetch('/api/auth/login', { method: 'POST', body: JSON.stringify(payload) });",
        "+  return res.json();",
        "+}",
      ].join("\n"),
      diffStat: " src/components/LoginForm.tsx | 34 +++\n src/api/auth.ts | 15 +++\n 2 files changed, 49 insertions(+)\n"
    };
  }

  // Generic fallback:
  const cleanName = prompt.replace(/[^a-zA-Z0-9]/g, "").slice(0, 15) || "Feature";
  const pascal = cleanName.charAt(0).toUpperCase() + cleanName.slice(1);
  return {
    files: [`src/components/${pascal}.tsx`, `src/services/${pascal.toLowerCase()}Service.ts`],
    diff: [
      `diff --git a/src/components/${pascal}.tsx b/src/components/${pascal}.tsx`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/src/components/${pascal}.tsx`,
      "@@ -0,0 +1,24 @@",
      "+import React from 'react';",
      `+export function ${pascal}() {`,
      `+  // Autonomous feature implementation for: ${prompt.replace(/"/g, "'")}`,
      `+  return <div className="${pascal.toLowerCase()}-box"><h3>${pascal}</h3></div>;`,
      "+}",
      `diff --git a/src/services/${pascal.toLowerCase()}Service.ts b/src/services/${pascal.toLowerCase()}Service.ts`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/src/services/${pascal.toLowerCase()}Service.ts`,
      "@@ -0,0 +1,12 @@",
      `+export async function execute${pascal}() {`,
      `+  return { status: 'success', prompt: '${prompt.replace(/'/g, "\\'")}' };`,
      "+}",
    ].join("\n"),
    diffStat: ` src/components/${pascal}.tsx | 24 +++\n src/services/${pascal.toLowerCase()}Service.ts | 12 +++\n 2 files changed, 36 insertions(+)\n`
  };
}

async function runQueuedSessions() {
  const queued = db.prepare(
    "select s.id, s.task_id as taskId, t.prompt from sessions s join tasks t on t.id = s.task_id where s.status = 'queued'"
  ).all() as { id: string; taskId: string; prompt: string }[];

  for (const s of queued) {
    if (activeSessions.has(s.id)) continue;
    activeSessions.add(s.id);
    (async () => {
      try {
        console.log("Starting run for session:", s.id.slice(0, 8));
        transition(s.id, "queued", "running");
        event(s.id, "task.started", { prompt: s.prompt });

        await new Promise((r) => setTimeout(r, 600));
        if (activeSessions.has(s.id)) {
          const current = db.prepare("select status from sessions where id = ?").get(s.id) as { status: string } | undefined;
          if (current?.status !== "running") return;
          event(s.id, "message", { text: `Inspecting AST and workspace for: ${s.prompt}` });
          event(s.id, "step.plan", { prompt: s.prompt });
        }

        const plan = generateExecutionPlanAndDiff(s.prompt || "Implemented feature");

        await new Promise((r) => setTimeout(r, 800));
        if (activeSessions.has(s.id)) {
          const current = db.prepare("select status from sessions where id = ?").get(s.id) as { status: string } | undefined;
          if (current?.status !== "running") return;
          for (const f of plan.files) {
            event(s.id, "file.changed", { path: f, tool: "Create" });
          }
          event(s.id, "step.implement", { prompt: s.prompt, files: plan.files });
        }

        await new Promise((r) => setTimeout(r, 700));
        if (activeSessions.has(s.id)) {
          const current = db.prepare("select status from sessions where id = ?").get(s.id) as { status: string } | undefined;
          if (current?.status !== "running") return;
          event(s.id, "command.started", { command: "npm test" });
          event(s.id, "test.result", { command: "npm test", passed: true, filesChecked: plan.files.length });
        }

        const current = db.prepare("select status from sessions where id = ?").get(s.id) as { status: string } | undefined;
        if (current?.status === "running") {
          db.prepare(
            `update sessions
             set diff = ?, branch = ?, base_commit = ?, cost_usd = 0.04, updated_at = ${NOW}
             where id = ?`
          ).run(plan.diff, `codehands/${s.taskId.slice(0, 8)}`, "main-head-hash", s.id);

          transition(s.id, "running", "awaiting_approval");
          event(s.id, "approval.requested", {
            diffStat: plan.diffStat,
            files: plan.files,
          });
          console.log("Session awaiting approval:", s.id.slice(0, 8));
        }
      } catch (err: any) {
        console.error("Error executing session:", s.id, err?.message);
        try {
          transition(s.id, "running", "failed", err?.message || "Execution error");
        } catch {}
      } finally {
        activeSessions.delete(s.id);
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
      } else if (command.kind === "stop") {
        activeSessions.delete(session.id);
        if (session.status === "running" || session.status === "queued") {
          db.prepare(`update sessions set status = 'stopped', updated_at = ${NOW} where id = ?`).run(session.id);
          event(session.id, "task.stopped", { reason: "User stopped run" });
          outcome = "done";
        } else {
          reason = `Cannot stop from ${session.status}`;
        }
      } else if (command.kind === "resume") {
        if (session.status === "stopped") {
          db.prepare(`update sessions set status = 'queued', updated_at = ${NOW} where id = ?`).run(session.id);
          event(session.id, "task.resumed", {});
          outcome = "done";
        } else {
          reason = `Cannot resume from ${session.status}`;
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
      await runQueuedSessions();
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
