import Fastify from "fastify";

const app = Fastify({ logger: true });

// In-memory "database" (disappears when you restart, that's fine for a mock)
const changes: any[] = [];

// 1. Sign up: return a fake user + device token
app.post("/auth/signup", async (req) => {
  const { deviceName } = req.body as any;
  return {
    userId: "user-1",
    device: { id: "device-1", name: deviceName, createdAt: new Date().toISOString() },
    deviceToken: "fake-token-123",
  };
});

// Log in: same fake shape as signup
app.post("/auth/login", async (req) => {
  const { deviceName } = req.body as any;
  return {
    userId: "user-1",
    device: { id: "device-1", name: deviceName, createdAt: new Date().toISOString() },
    deviceToken: "fake-token-123",
  };
});

// Log out: nothing to revoke in the mock
app.post("/auth/logout", async () => {
  return { ok: true };
});

// 2. Push: store changes, skip ones we already have (safe to resend)
app.post("/sync/push", async (req) => {
  const { changes: incoming } = req.body as any;
  const accepted: string[] = [];
  for (const c of incoming) {
    const exists = changes.some((x) => x.kind === c.kind && x.id === c.id);
    if (!exists) changes.push(c);
    accepted.push(c.id);
  }
  return { accepted, rejected: [] };
});

// 3. Pull: return everything after the cursor
app.get("/sync/pull", async (req) => {
  const cursor = Number((req.query as any).cursor ?? 0);
  return {
    changes: changes.slice(cursor),
    nextCursor: String(changes.length),
    hasMore: false,
  };
});

// List devices: fake data
app.get("/devices", async () => {
  return { devices: [{ id: "device-1", name: "laptop-A", createdAt: new Date().toISOString() }] };
});

// Revoke a device: nothing to revoke in the mock
app.post("/devices/:id/revoke", async () => {
  return { ok: true };
});

app.listen({ port: Number(process.env.MOCK_PORT ?? 4000) });