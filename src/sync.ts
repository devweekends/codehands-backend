import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { requireAuth } from "./auth.js";
import { checkData } from "./guard.js";

const KINDS = ["project", "session", "event", "memory", "preference"];
const MAX_BATCH = 500;
const PAGE = 500;

type Change = {
  kind: string;
  id: string;
  version: number;
  deleted?: boolean;
  data?: Record<string, unknown>;
};

export async function syncRoutes(app: FastifyInstance, opts: { pool: pg.Pool }) {
  const { pool } = opts;
  const auth = requireAuth(pool);

  app.post("/sync/push", { preHandler: auth }, async (req, reply) => {
    const { changes } = (req.body ?? {}) as { changes?: Change[] };
    if (!Array.isArray(changes) || changes.length > MAX_BATCH) {
      return reply.code(400).send({ error: `changes must be an array of at most ${MAX_BATCH}` });
    }
    const { userId, deviceId } = req.auth!;
    const accepted: string[] = [];
    const rejected: { id: string; reason: string }[] = [];

    for (const c of changes) {
      if (
        !c || !KINDS.includes(c.kind) ||
        typeof c.id !== "string" || c.id.length === 0 || c.id.length > 200 ||
        !Number.isInteger(c.version)
      ) {
        return reply.code(400).send({ error: "each change needs kind, id and an integer version" });
      }

      const bad = checkData(c.data ?? {});
      if (bad) {
        rejected.push({ id: c.id, reason: bad });
        continue;
      }
      const data = JSON.stringify(c.data ?? {});

      if (c.kind === "event") {
        await pool.query(
          `insert into records (user_id, kind, id, version, data, device_id)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (user_id, kind, id) do nothing`,
          [userId, c.kind, c.id, c.version, data, deviceId]
        );
        accepted.push(c.id);
        continue;
      }

      const r = await pool.query(
        `insert into records (user_id, kind, id, version, deleted, data, device_id)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (user_id, kind, id) do update set
           version = excluded.version,
           deleted = excluded.deleted,
           data = excluded.data,
           device_id = excluded.device_id,
           seq = nextval('records_seq'),
           updated_at = now()
         where records.version < excluded.version`,
        [userId, c.kind, c.id, c.version, c.deleted ?? false, data, deviceId]
      );
      if (r.rowCount === 0) {
        const cur = await pool.query(
          "select version from records where user_id = $1 and kind = $2 and id = $3",
          [userId, c.kind, c.id]
        );
        if (Number(cur.rows[0]?.version) === c.version) accepted.push(c.id);
        else rejected.push({ id: c.id, reason: "stale" });
      } else {
        accepted.push(c.id);
      }
    }
    return { accepted, rejected };
  });

  app.get("/sync/pull", { preHandler: auth }, async (req, reply) => {
    const raw = (req.query as { cursor?: string }).cursor || "0";
    if (!/^\d+$/.test(raw)) return reply.code(400).send({ error: "cursor must be a number" });

    const r = await pool.query(
      `select kind, id, version, deleted, data, seq from records
       where user_id = $1 and seq > $2 order by seq limit ${PAGE}`,
      [req.auth!.userId, raw]
    );
    const last = r.rows[r.rows.length - 1];
    return {
      changes: r.rows.map((x) => ({
        kind: x.kind, id: x.id, version: Number(x.version), deleted: x.deleted, data: x.data,
      })),
      nextCursor: last ? String(last.seq) : raw,
      hasMore: r.rows.length === PAGE,
    };
  });
}