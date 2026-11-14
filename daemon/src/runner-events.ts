
import { openDb } from "./db.js";
import type { RunnerEvent } from "../../../codehands-contracts/src/runner.ts";

export function saveRunnerEvent(runnerEvent: RunnerEvent): number {
  const db = openDb();

  try {
    return db.transaction(() => {
      const row = db.prepare(`
        SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
        FROM events
        WHERE session_id = ?
      `).get(runnerEvent.sessionId) as {
        next_seq: number;
      };

      db.prepare(`
        INSERT INTO events (session_id, seq, type, payload)
        VALUES (?, ?, ?, ?)
      `).run(
        runnerEvent.sessionId,
        row.next_seq,
        runnerEvent.type,
        JSON.stringify({
          ...runnerEvent.payload,
          runnerSeq: runnerEvent.seq,
          at: runnerEvent.at,
          ...(runnerEvent.raw === undefined
            ? {}
            : { raw: runnerEvent.raw }),
        })
      );

      return row.next_seq;
    })();
  } finally {
    db.close();
  }
}

