import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { openDb } from "./db.js";

const AGENTS = ["claude-code", "codex", "codehands"];

function usage(): never {
  console.log('Usage:');
  console.log('  codehands task add "prompt" [--agent claude-code|codex|codehands]');
  console.log('  codehands task list');
  process.exit(1);
}

function originUrl(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["config", "--get", "remote.origin.url"], { cwd, encoding: "utf8" });
    return out.trim() || null;
  } catch {
    return null;
  }
}

const [group, action, ...rest] = process.argv.slice(2);
if (group !== "task") usage();

try {
  const db = openDb();

  if (action === "add") {
    const args = [...rest];
    let agent = "claude-code";
    const i = args.indexOf("--agent");
    if (i !== -1) {
      agent = args[i + 1] ?? "";
      args.splice(i, 2);
    }
    const prompt = args.join(" ").trim();
    if (!prompt) usage();
    if (!AGENTS.includes(agent)) {
      console.error("Unknown agent: " + agent + ". Use one of: " + AGENTS.join(", "));
      process.exit(1);
    }

    const cwd = process.cwd();
    const repoId = createHash("sha256").update(originUrl(cwd) ?? cwd).digest("hex").slice(0, 16);

    let project = db.prepare("select id from projects where repo_id = ?").get(repoId) as { id: string } | undefined;
    if (!project) {
      project = { id: randomUUID() };
      db.prepare("insert into projects (id, name, repo_id, path) values (?, ?, ?, ?)")
        .run(project.id, basename(cwd), repoId, cwd);
      console.log("project created:", basename(cwd));
    }

    const id = randomUUID();
    db.prepare("insert into tasks (id, project_id, prompt, agent, created_by) values (?, ?, ?, ?, ?)")
      .run(id, project.id, prompt, agent, "cli");
    console.log("task added:", id, "(agent: " + agent + ")");
  } else if (action === "list") {
    const rows = db.prepare(
      "select substr(t.id, 1, 8) as task, t.agent, substr(t.prompt, 1, 40) as prompt, coalesce(s.status, '(no session yet)') as status " +
      "from tasks t left join sessions s on s.task_id = t.id order by t.created_at"
    ).all();
    console.table(rows);
  } else {
    usage();
  }
} catch (err) {
  console.error("Failed:", (err as Error).message);
  console.error("If it says 'no such table', run: npm run db:migrate");
  process.exit(1);
}
