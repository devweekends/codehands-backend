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

type GithubUser = {
  id: string;
  login: string;
};

class GithubInvalidCodeError extends Error {
  constructor() {
    super("GitHub authorization code is invalid or expired");
    this.name = "GithubInvalidCodeError";
  }
}

class GithubServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubServiceError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Ask GitHub who this code belongs to.
async function githubUser(
  code: string,
  fetchImpl: typeof fetch = fetch
): Promise<GithubUser> {
  let tokenRes: Response;

  try {
    tokenRes = await fetchImpl(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          client_id: process.env.GITHUB_CLIENT_ID,
          client_secret: process.env.GITHUB_CLIENT_SECRET,
          code,
        }),
        signal: AbortSignal.timeout(10_000),
      }
    );
  } catch {
    throw new GithubServiceError("GitHub OAuth request failed");
  }

  let tokenJson: unknown;

  try {
    tokenJson = await tokenRes.json();
  } catch {
    throw new GithubServiceError("Invalid response from GitHub OAuth");
  }

  if (
    isObject(tokenJson) &&
    tokenJson.error === "bad_verification_code"
  ) {
    throw new GithubInvalidCodeError();
  }

  if (!tokenRes.ok) {
    throw new GithubServiceError(
      `GitHub OAuth returned status ${tokenRes.status}`
    );
  }

  if (
    !isObject(tokenJson) ||
    typeof tokenJson.access_token !== "string" ||
    !tokenJson.access_token
  ) {
    throw new GithubServiceError("GitHub did not return an access token");
  }

  let userRes: Response;

  try {
    userRes = await fetchImpl("https://api.github.com/user", {
      headers: {
        authorization: `Bearer ${tokenJson.access_token}`,
        accept: "application/vnd.github+json",
        "user-agent": "codehands-backend",
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new GithubServiceError("GitHub user request failed");
  }

  if (!userRes.ok) {
    throw new GithubServiceError(
      `GitHub user API returned status ${userRes.status}`
    );
  }

  let userJson: unknown;

  try {
    userJson = await userRes.json();
  } catch {
    throw new GithubServiceError("Invalid GitHub user response");
  }

  if (
    !isObject(userJson) ||
    typeof userJson.id !== "number" ||
    !Number.isSafeInteger(userJson.id) ||
    userJson.id <= 0 ||
    typeof userJson.login !== "string" ||
    !userJson.login.trim()
  ) {
    throw new GithubServiceError("GitHub returned invalid user information");
  }

  return {
    id: String(userJson.id),
    login: userJson.login,
  };
}


export async function authRoutes(
  app: FastifyInstance,
  opts: {
    pool: pg.Pool;
    fetchImpl?: typeof fetch;
  }
) {
  const { pool } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;

  // Dev helper: GitHub sends you here after you approve. It just shows the code.
  app.get("/auth/github/callback", async (req: FastifyRequest, reply: FastifyReply) => {
    const { code } = req.query as { code?: string };
    reply.type("text/plain");
    return code ? `Your code: ${code}` : "No code in the URL.";
  });

  async function signIn(req: FastifyRequest, reply: FastifyReply) {
    const body = (req.body ?? {}) as {
      githubCode?: string;
      deviceName?: string;
      email?: string;
      password?: string;
      name?: string;
      provider?: "github" | "google" | "email";
      providerId?: string;
      avatarUrl?: string;
    };

    const deviceName = (body.deviceName && body.deviceName.trim()) || "desktop-client-windows";

    let identityId: string;
    let identityLogin: string;
    let userEmail: string;
    let authProvider: "github" | "google" | "email" = body.provider || "email";

    if (body.provider === "google") {
      const email = (body.email && body.email.trim().toLowerCase()) || "google.developer@gmail.com";
      userEmail = email;
      authProvider = "google";
      identityId = "google:" + (body.providerId || email);
      identityLogin = (body.name && body.name.trim()) || email.split("@")[0].replace(/[._-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    } else if (body.provider === "github" || (typeof body.githubCode === "string" && body.githubCode.trim())) {
      authProvider = "github";
      if (typeof body.githubCode === "string" && body.githubCode.trim() && !body.providerId) {
        try {
          const gh = await githubUser(body.githubCode.trim(), fetchImpl);
          identityId = "github:" + String(gh.id);
          identityLogin = gh.login;
          userEmail = body.email || `${gh.login}@users.noreply.github.com`;
        } catch (error) {
          if (error instanceof GithubInvalidCodeError) {
            return reply.code(401).send({
              error: "GitHub authorization code is invalid or expired",
            });
          }
          req.log.error({ err: error }, "GitHub authentication failed");
          return reply.code(502).send({
            error: "GitHub authentication service is temporarily unavailable",
          });
        }
      } else {
        const ghLogin = (body.name && body.name.trim()) || (body.email ? body.email.split("@")[0] : "github-dev");
        userEmail = body.email ? body.email.trim().toLowerCase() : `${ghLogin}@github.com`;
        identityId = "github:" + (body.providerId || userEmail);
        identityLogin = ghLogin;
      }
    } else if (body.email && typeof body.email === "string" && body.email.includes("@")) {
      const email = body.email.trim().toLowerCase();
      userEmail = email;
      authProvider = "email";
      identityId = "email:" + email;
      identityLogin = (body.name && body.name.trim()) || email.split("@")[0].replace(/[._-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    } else {
      return reply.code(400).send({
        error: "Either email and password or provider (github / google) is required",
      });
    }

    // Create a new user or update the existing account in Neon Postgres
    const u = await pool.query(
      `insert into users (github_id, github_login)
       values ($1, $2)
       on conflict (github_id)
       do update set github_login = excluded.github_login
       returning id`,
      [identityId, identityLogin]
    );

    const userId = u.rows[0].id;
    const deviceToken = randomBytes(32).toString("hex");

    // Store token hash in the database
    const d = await pool.query(
      `insert into devices (user_id, name, token_hash)
       values ($1, $2, $3)
       returning id, name, created_at`,
      [userId, deviceName, hashToken(deviceToken)]
    );

    const row = d.rows[0];

    return {
      userId,
      name: identityLogin,
      email: userEmail,
      provider: authProvider,
      avatarUrl: body.avatarUrl || null,
      device: {
        id: row.id,
        name: row.name,
        createdAt: row.created_at,
      },
      deviceToken,
    };
  }
  // With GitHub, sign up and log in do the same thing
  app.post("/auth/signup", signIn);
  app.post("/auth/login", signIn);
  app.post("/auth/social", signIn);

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