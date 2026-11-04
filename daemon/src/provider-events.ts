import { openDb } from "./db.js";

export type ProviderStatusEvent = {
  agent: "codex" | "claude-code";
  state:
    | "ok"
    | "not_installed"
    | "not_logged_in"
    | "rate_limited"
    | "usage_limited"
    | "outage";
  reason: string | null;
  retry_at: string | null;
};

export function saveProviderEvent(data: ProviderStatusEvent): void {
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
      VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(agent) DO UPDATE SET
        state = excluded.state,
        reason = excluded.reason,
        retry_at = excluded.retry_at,
        checked_at = excluded.checked_at
    `).run(
      data.agent,
      data.state,
      data.reason,
      data.retry_at
    );
  } finally {
    db.close();
  }
}