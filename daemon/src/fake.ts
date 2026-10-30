import { randomUUID } from "node:crypto";
import { openDb } from "./db.js";

const db = openDb();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

const FAKE_DIFF = [
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,5 @@",
  " export function main() {",
  "+  // fake change made by the fake writer",
  "+  console.log('hello');",
  " }",
].join("\n");

function addEvent(sessionId: string, type: string, payload: object = {}) {
  const row = db.prepare("select coalesce(max(seq), 0) + 1 as n from events where session_id = ?").get(sessionId) as { n: number };
  db.prepare("insert into events (session_id, seq, type, payload) values (?, ?, ?, ?)")
    .run(sessionId, row.n, type, JSON.stringify(payload));
  console.log("  event " + row.n + ": " + type);
}

function setStatus(sessionId: string, status: string) {
  db.prepare("update sessions set status = ?, updated_at = " + NOW + " where id = ?").run(status, sessionId);
  console.log("  status -> " + status);
}

async function run() {
  const tasks = db.prepare(
    "select t.id, t.project_id, t.agent, t.models from tasks t " +
    "left join sessions s on s.task_id = t.id where s.id is null order by t.created_at"
  ).all() as { id: string; project_id: string; agent: string; models: string }[];

  if (tasks.length === 0) {
    console.log("no tasks waiting (every task already has a session)");
    return;
  }

  for (const t of tasks) {
    const models = JSON.parse(t.models || "{}") as Record<string, string>;
    const model = models.implement ?? Object.values(models)[0] ?? "fake-model";
    const sessionId = randomUUID();

    console.log("session " + sessionId.slice(0, 8) + " for task " + t.id.slice(0, 8));
    db.prepare("insert into sessions (id, task_id, project_id, agent, model) values (?, ?, ?, ?, ?)")
      .run(sessionId, t.id, t.project_id, t.agent, model);

    setStatus(sessionId, "running");
    addEvent(sessionId, "task.started");
    await sleep(300);
    addEvent(sessionId, "step.plan");
    await sleep(300);
    addEvent(sessionId, "step.implement");
    await sleep(300);

    db.prepare("update sessions set diff = ?, branch = ?, base_commit = ?, cost_usd = ? where id = ?")
      .run(FAKE_DIFF, "codehands/" + t.id.slice(0, 8), "abc1234", 0.12, sessionId);
    setStatus(sessionId, "awaiting_approval");
    addEvent(sessionId, "approval.requested");
  }
}

function finish(prefix: string, outcome: "approve" | "reject") {
  const s = db.prepare("select id, status from sessions where id like ? || '%'").get(prefix) as { id: string; status: string } | undefined;
  if (!s) return console.log("no session starts with " + prefix);
  if (s.status !== "awaiting_approval") return console.log("session is " + s.status + ", can only " + outcome + " from awaiting_approval");

  if (outcome === "approve") {
    addEvent(s.id, "step.test");
    addEvent(s.id, "task.finished");
    setStatus(s.id, "approved");
  } else {
    addEvent(s.id, "task.rejected");
    setStatus(s.id, "rejected");
  }
}

const [action, arg] = process.argv.slice(2);
try {
  if (action === "run") await run();
  else if (action === "approve" && arg) finish(arg, "approve");
  else if (action === "reject" && arg) finish(arg, "reject");
  else if (action === "show") {
    console.table(db.prepare(
      "select substr(s.id, 1, 8) as session, substr(s.task_id, 1, 8) as task, s.status, s.agent, s.model, " +
      "(select count(*) from events e where e.session_id = s.id) as events from sessions s order by s.created_at"
    ).all());
  } else if (action === "events" && arg) {
    console.table(db.prepare(
      "select e.seq, e.type from events e where e.session_id like ? || '%' order by e.seq"
    ).all(arg));
  } else {
    console.log("Usage: npm run fake -- run | show | events <id> | approve <id> | reject <id>");
  }
} catch (err) {
  console.error("Failed:", (err as Error).message);
  process.exit(1);
}
