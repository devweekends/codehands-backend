import { execaSync } from "execa";
import { openDb } from "./db.js";

type Agent = "codex" | "claude-code";

type ProviderState =
  | "ok"
  | "not_installed"
  | "not_logged_in"
  | "rate_limited"
  | "usage_limited"
  | "outage";

type ProviderResult = {
  state: ProviderState;
  reason: string | null;
  retry_at: string | null;
};

// execa, not node:child_process: on Windows, npm installs a CLI as a .cmd file
// (claude.cmd), and spawnSync cannot find that by the name "claude".
function commandSucceeds(command: string, args: string[]): boolean {
  const result = execaSync(command, args, {
    reject: false, // a missing or failing CLI is an answer, not a crash
    stdin: "ignore",
    timeout: 5000,
  });

  return !result.failed;
}

// Check whether Codex or Claude Code is installed
export function isCliInstalled(agent: Agent): boolean {
  const command = agent === "claude-code" ? "claude" : "codex";

  return commandSucceeds(command, ["--version"]);
}

// Check Codex authentication
export function isCodexLoggedIn(): boolean {
  return commandSucceeds("codex", ["login", "status"]);
}

// Check Claude Code authentication
export function isClaudeLoggedIn(): boolean {
  return commandSucceeds("claude", ["auth", "status"]);
}

// Check installation and authentication
export function checkProvider(agent: Agent): ProviderResult {
  if (!isCliInstalled(agent)) {
    return {
      state: "not_installed",
      reason: `${agent} CLI is not installed`,
      retry_at: null,
    };
  }

  if (agent === "codex" && !isCodexLoggedIn()) {
    return {
      state: "not_logged_in",
      reason: "Codex CLI is installed but not logged in",
      retry_at: null,
    };
  }

  if (agent === "claude-code" && !isClaudeLoggedIn()) {
    return {
      state: "not_logged_in",
      reason: "Claude Code CLI is installed but not logged in",
      retry_at: null,
    };
  }

  return {
    state: "ok",
    reason: null,
    retry_at: null,
  };
}

// Save provider status to the SQLite database
export function saveProviderStatus(agent: Agent): ProviderResult {
  const result = checkProvider(agent);
  const db = openDb();

  try {
    db.prepare(`
      INSERT INTO provider_status (
        agent,
        state,
        reason,
        retry_at,
        checked_at
      )
      VALUES (
        ?, ?, ?, ?,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      )
      ON CONFLICT(agent) DO UPDATE SET
        state = excluded.state,
        reason = excluded.reason,
        retry_at = excluded.retry_at,
        checked_at = excluded.checked_at
    `).run(
      agent,
      result.state,
      result.reason,
      result.retry_at
    );

    return result;
  } finally {
    db.close();
  }
}


export function getActiveProviderLimit(
  agent: "codex" | "claude-code"
): {
  state: "rate_limited" | "usage_limited";
  reason: string | null;
  retry_at: string | null;
} | null {
  const db = openDb();

  try {
    const row = db.prepare(`
      SELECT state, reason, retry_at
      FROM provider_status
      WHERE agent = ?
        AND state IN ('rate_limited', 'usage_limited')
    `).get(agent) as {
      state: "rate_limited" | "usage_limited";
      reason: string | null;
      retry_at: string | null;
    } | undefined;

    if (!row) return null;

    // A missing retry time means the limit remains active
    // until a new provider event updates the status.
    if (row.retry_at === null) return row;

    const retryTime = Date.parse(row.retry_at);

    if (Number.isNaN(retryTime)) return row;

    return retryTime > Date.now() ? row : null;
  } finally {
    db.close();
  }
}