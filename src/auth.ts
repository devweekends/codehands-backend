import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type pg from "pg";

declare module "fastify" {
  interface FastifyRequest {
    auth?: { userId: string; deviceId: string };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// The door check. Put it on any route that needs a signed-in laptop.
export function requireAuth(pool: pg.Pool) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) return reply.code(401).send({ error: "missing token" });

    const r = await pool.query(
      "select id, user_id from devices where token_hash = $1 and revoked_at is null",
      [hashToken(token)]
    );
    if (r.rowCount === 0) {
      return reply.code(401).send({ error: "invalid or revoked token" });
    }
    req.auth = { userId: r.rows[0].user_id, deviceId: r.rows[0].id };
    await pool.query("update devices set last_seen_at = now() where id = $1", [
      r.rows[0].id,
    ]);
  };
}

// Ask GitHub who this code belongs to. The GitHub token is never stored.
async function githubUser(code: string) {
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });
  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  if (!tokenJson.access_token) return null;

  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${tokenJson.access_token}`,
      accept: "application/vnd.github+json",
      "user-agent": "codehands-backend",
    },
  });
  if (!userRes.ok) return null;
  const u = (await userRes.json()) as { id: number; login: string };
  return { id: String(u.id), login: u.login };
}

export async function authRoutes(app: FastifyInstance, opts: { pool: pg.Pool }) {
  const { pool } = opts;

  // Dev helper: GitHub sends you here after you approve. It just shows the code.
  app.get("/auth/github/callback", async (req: FastifyRequest, reply: FastifyReply) => {
    const { code } = req.query as { code?: string };
    reply.type("text/plain");
    return code ? `Your code: ${code}` : "No code in the URL.";
  });

  async function signIn(req: FastifyRequest, reply: FastifyReply) {
    const { githubCode, deviceName } = (req.body ?? {}) as {
      githubCode?: string;
      deviceName?: string;
    };
    if (!githubCode || !deviceName) {
      return reply.code(400).send({ error: "githubCode and deviceName are required" });
    }

    const gh = await githubUser(githubCode);
    if (!gh) return reply.code(401).send({ error: "GitHub rejected the code" });

    const u = await pool.query(
      `insert into users (github_id, github_login) values ($1, $2)
       on conflict (github_id) do update set github_login = excluded.github_login
       returning id`,
      [gh.id, gh.login]
    );
    const userId = u.rows[0].id;

    // The real token is returned once. Only its hash goes in the database.
    const deviceToken = randomBytes(32).toString("hex");
    const d = await pool.query(
      `insert into devices (user_id, name, token_hash) values ($1, $2, $3)
       returning id, name, created_at`,
      [userId, deviceName, hashToken(deviceToken)]
    );
    const row = d.rows[0];
    return {
      userId,
      device: { id: row.id, name: row.name, createdAt: row.created_at },
      deviceToken,
    };
  }

  // With GitHub, sign up and log in do the same thing
  app.post("/auth/signup", signIn);
  app.post("/auth/login", signIn);

  const auth = requireAuth(pool);

  // Logout revokes only the laptop that is asking
  app.post("/auth/logout", { preHandler: auth }, async (req) => {
    await pool.query("update devices set revoked_at = now() where id = $1", [
      req.auth!.deviceId,
    ]);
    return { ok: true };
  });

  // List my devices (only mine)
  app.get("/devices", { preHandler: auth }, async (req) => {
    const r = await pool.query(
      `select id, name, created_at from devices
       where user_id = $1 and revoked_at is null order by created_at`,
      [req.auth!.userId]
    );
    return {
      devices: r.rows.map((d) => ({ id: d.id, name: d.name, createdAt: d.created_at })),
    };
  });

  // Revoke one of my devices. The user_id check is the ownership rule.
  app.post("/devices/:id/revoke", { preHandler: auth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) return reply.code(404).send({ error: "device not found" });
    const r = await pool.query(
      `update devices set revoked_at = now()
       where id = $1 and user_id = $2 and revoked_at is null returning id`,
      [id, req.auth!.userId]
    );
    if (r.rowCount === 0) return reply.code(404).send({ error: "device not found" });
    return { ok: true };
  });
}