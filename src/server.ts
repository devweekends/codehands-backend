import "dotenv/config";
import Fastify from "fastify";
import pg from "pg";
import { WebSocketServer, WebSocket } from "ws";
import { authRoutes } from "./auth.js";
import { syncRoutes } from "./sync.js";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const app = Fastify({ logger: true });

app.setErrorHandler((error, request, reply) => {
  const code = (error as Error & { code?: string }).code;
  request.log.error(error);

  if (
    ["ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "08000", "08003", "08006", "3D000"].includes(code ?? "")
  ) {
    return reply.code(503).send({
      error: "Auth database is unavailable. Configure DATABASE_URL and make sure PostgreSQL is running.",
    });
  }

  if (["42P01", "42703"].includes(code ?? "")) {
    return reply.code(503).send({
      error: "Auth database schema is outdated. Run the backend migration, then restart the API.",
    });
  }

  return reply.code(500).send({ error: "Internal Server Error" });
});

const allowedDesktopOrigins = new Set([
  "http://localhost:1420",
  "http://127.0.0.1:1420",
  "http://tauri.localhost",
  "tauri://localhost",
  ...(process.env.DESKTOP_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
]);

// CORS for web and desktop app clients
app.addHook("onRequest", async (request, reply) => {
  const origin = request.headers.origin;

  if (origin && allowedDesktopOrigins.has(origin)) {
    reply.header("Access-Control-Allow-Origin", origin);
    reply.header("Vary", "Origin");
    reply.header(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, DELETE, OPTIONS, PATCH"
    );
    reply.header(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Requested-With, Origin, Accept"
    );
  }

  if (request.method === "OPTIONS") {
    return reply.code(204).send();
  }
});

// Connected daemons, keyed by device ID
const daemons = new Map<string, WebSocket>();

// Endpoint to register/sync sessions into Neon PostgreSQL
app.post("/sessions", async (request, reply) => {
  const { id, deviceId, status } = (request.body ?? {}) as {
    id?: string;
    deviceId?: string;
    status?: string;
  };

  let dId = deviceId;
  if (!dId) {
    const dRes = await pool.query("select id from devices order by created_at desc limit 1");
    dId = dRes.rows[0]?.id;
  }
  if (!dId) {
    const uRes = await pool.query("select id from users order by created_at desc limit 1");
    let uId = uRes.rows[0]?.id;
    if (!uId) {
      const u = await pool.query("insert into users (github_id, github_login) values ('default', 'developer') returning id");
      uId = u.rows[0].id;
    }
    const d = await pool.query("insert into devices (user_id, name) values ($1, 'desktop-client') returning id", [uId]);
    dId = d.rows[0].id;
  }

  const result = await pool.query(
    `insert into sessions (id, device_id, status)
     values (coalesce($1, gen_random_uuid()), $2, coalesce($3, 'running'))
     on conflict (id) do update set status = excluded.status
     returning id, device_id, status, created_at`,
    [id, dId, status ?? "running"]
  );

  return result.rows[0];
});

app.get("/sessions", async () => {
  const result = await pool.query("select * from sessions order by created_at desc limit 100");
  return { sessions: result.rows };
});

app.get("/health", async () => {
  const result = await pool.query("select now() as db_time");
  return { ok: true, db_time: result.rows[0].db_time };
});

app.post("/commands", async (request, reply) => {
  const { deviceId, type, payload } = request.body as {
    deviceId: string;
    type: string;
    payload?: unknown;
  };

  const result = await pool.query(
    "insert into commands (device_id, type, payload) values ($1, $2, $3) returning id",
    [deviceId, type, JSON.stringify(payload ?? {})]
  );
  const commandId = result.rows[0].id;

  const socket = daemons.get(deviceId);
  if (!socket) {
    return reply.code(202).send({ commandId, delivered: false });
  }

  // A "start" command begins a session; the daemon tags its events with this ID
  let sessionId: string | null = null;
  if (type === "start") {
    const s = await pool.query(
      "insert into sessions (device_id, status) values ($1, 'running') returning id",
      [deviceId]
    );
    sessionId = s.rows[0].id;
  }

  socket.send(
    JSON.stringify({
      type: "command",
      commandId,
      commandType: type,
      sessionId,
      payload: payload ?? {},
    })
  );
  await pool.query("update commands set status = 'sent' where id = $1", [commandId]);
  return { commandId, sessionId, delivered: true };
});

 //add auth route today :)
    await app.register(authRoutes, { pool });
    await app.register(syncRoutes, { pool });
const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: "0.0.0.0" });

// WebSocket server attached to the same HTTP server
const wss = new WebSocketServer({ server: app.server, path: "/ws" });

wss.on("connection", (socket, req) => {
  const url = new URL(req.url ?? "", "http://localhost");
  const token = url.searchParams.get("token");
  const deviceId = url.searchParams.get("deviceId");

  if (token !== process.env.DEV_TOKEN || !deviceId) {
    socket.close(4001, "unauthorized");
    return;
  }

  daemons.set(deviceId, socket);
  app.log.info({ deviceId }, "daemon connected");
  socket.send(JSON.stringify({ type: "hello", deviceId }));

  socket.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === "ack") {
        await pool.query(
          "update commands set status = 'acked', acked_at = now() where id = $1",
          [msg.commandId]
        );
        app.log.info({ commandId: msg.commandId }, "command acked");
      }

      if (msg.type === "event") {
        await pool.query(
          "insert into events (session_id, type, payload, device_ts) values ($1, $2, $3, $4)",
          [msg.sessionId, msg.eventType, JSON.stringify(msg.payload ?? {}), msg.deviceTs]
        );

        // Tell the daemon the event is safely stored, so it can time the round trip
        socket.send(JSON.stringify({ type: "event_ack", clientEventId: msg.clientEventId }));

        if (msg.eventType === "task.finished") {
          await pool.query("update sessions set status = 'finished' where id = $1", [
            msg.sessionId,
          ]);
        }
      }
    } catch (err) {
      app.log.error({ err }, "failed to handle daemon message");
    }
  });

  socket.on("close", () => {
    // Only remove it if this is still the registered socket for the device
    if (daemons.get(deviceId) === socket) daemons.delete(deviceId);
    app.log.info({ deviceId }, "daemon disconnected");
  });
});