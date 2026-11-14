import { openDb } from "./db.js";
import type { StartOptions } from "../../../codehands-contracts/src/runner.ts";

type StartOptionsRow = {
  session_id: string;
  repo_path: string;
  prompt: string;
  agent: string;
  model: string;
};

export function buildStartOptions(
  sessionId: string
): StartOptions {
  const db = openDb();

  try {
    const row = db.prepare(`
      SELECT
        s.id AS session_id,
        p.path AS repo_path,
        t.prompt,
        t.agent,
        s.model
      FROM sessions s
      JOIN tasks t ON t.id = s.task_id
      JOIN projects p ON p.id = s.project_id
      WHERE s.id = ?
    `).get(sessionId) as StartOptionsRow | undefined;

    if (!row) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (
      row.agent !== "codex" &&
      row.agent !== "claude-code"
    ) {
      throw new Error(
        `Unsupported runner agent: ${row.agent}`
      );
    }

    return {
      sessionId: row.session_id,
      repoPath: row.repo_path,
      prompt: row.prompt,
      agent: row.agent,
      // An empty model means "unset": leave it out so the runner
      // does not receive --model with a placeholder value.
      ...(row.model ? { model: row.model } : {}),
    };
  } finally {
    db.close();
  }
}
