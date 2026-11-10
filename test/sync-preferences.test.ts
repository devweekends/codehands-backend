import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import type pg from "pg";
import { syncRoutes } from "../src/sync.js";
import { hashToken } from "../src/auth.js";
import type { ModelRegistry } from "../src/models/model.types.js";

const TEST_TOKEN = "test-token-123456789012345678901234567890";
const USER_ID = "user-abc";
const DEVICE_ID = "device-xyz";

const testRegistry: ModelRegistry = {
  models: [
    {
      id: "claude-opus-5-5",
      provider: "anthropic",
      pricing: {
        inputPerMillion: 4,
        outputPerMillion: 20,
      },
      contextSize: 1000000,
      capabilities: ["coding", "reasoning"],
      pricingSource: "https://example.com/pricing",
      pricingVerifiedAt: "2026-11-08",
    },
    {
      id: "claude-sonnet-5-5",
      provider: "anthropic",
      pricing: {
        inputPerMillion: 3,
        outputPerMillion: 15,
      },
      contextSize: 200000,
      capabilities: ["coding"],
      pricingSource: "https://example.com/pricing",
      pricingVerifiedAt: "2026-11-08",
    },
  ],
};

function createMockPool() {
  const records = new Map<string, { version: number; deleted: boolean; data: unknown }>();

  return {
    query: async (sql: string, values?: unknown[]) => {
      // Auth query
      if (sql.includes("from devices where token_hash")) {
        const hash = values?.[0];
        if (hash === hashToken(TEST_TOKEN)) {
          return {
            rows: [{ id: DEVICE_ID, user_id: USER_ID }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }

      // Last seen update
      if (sql.includes("update devices set last_seen_at")) {
        return { rows: [], rowCount: 1 };
      }

      // Upsert into records
      if (sql.includes("insert into records")) {
        const userId = values?.[0] as string;
        const kind = values?.[1] as string;
        const id = values?.[2] as string;
        const version = Number(values?.[3]);
        const deleted = Boolean(values?.[4]);
        const data = values?.[5];

        const key = `${userId}:${kind}:${id}`;
        const existing = records.get(key);

        if (!existing) {
          records.set(key, { version, deleted, data });
          return { rowCount: 1, rows: [] };
        }

        if (version > existing.version) {
          records.set(key, { version, deleted, data });
          return { rowCount: 1, rows: [] };
        }

        return { rowCount: 0, rows: [] };
      }

      // Query existing version
      if (sql.includes("select version from records where user_id")) {
        const userId = values?.[0] as string;
        const kind = values?.[1] as string;
        const id = values?.[2] as string;
        const key = `${userId}:${kind}:${id}`;
        const existing = records.get(key);
        return {
          rows: existing ? [{ version: existing.version }] : [],
          rowCount: existing ? 1 : 0,
        };
      }

      throw new Error(`Unhandled mock SQL query: ${sql}`);
    },
  } as unknown as pg.Pool;
}

async function createTestApp(registry = testRegistry) {
  const app = Fastify();
  await app.register(syncRoutes, {
    pool: createMockPool(),
    registry,
  });
  return app;
}

const validPreferencesData = {
  modelPerPhase: {
    analyze: {
      primary: "claude-sonnet-5-5",
      backups: [],
    },
    plan: {
      primary: "claude-opus-5-5",
      backups: ["claude-sonnet-5-5"],
    },
    implement: {
      primary: "claude-opus-5-5",
      backups: ["claude-sonnet-5-5"],
    },
    review: {
      primary: "claude-sonnet-5-5",
      backups: [],
    },
  },
};

describe("Sync preferences per-kind validation", () => {
  it("accepts valid model-preferences", async () => {
    const app = await createTestApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/sync/push",
        headers: {
          authorization: `Bearer ${TEST_TOKEN}`,
        },
        payload: {
          changes: [
            {
              kind: "preference",
              id: "model-preferences",
              version: 1,
              data: validPreferencesData,
            },
          ],
        },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.deepEqual(body.accepted, ["model-preferences"]);
      assert.deepEqual(body.rejected, []);
    } finally {
      await app.close();
    }
  });

  it("rejects model preferences with an unknown phase", async () => {
    const app = await createTestApp();
    try {
      const invalidData = {
        modelPerPhase: {
          ...validPreferencesData.modelPerPhase,
          test: {
            primary: "claude-opus-5-5",
            backups: [],
          },
        },
      };

      const res = await app.inject({
        method: "POST",
        url: "/sync/push",
        headers: {
          authorization: `Bearer ${TEST_TOKEN}`,
        },
        payload: {
          changes: [
            {
              kind: "preference",
              id: "model-preferences",
              version: 1,
              data: invalidData,
            },
          ],
        },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.deepEqual(body.accepted, []);
      assert.equal(body.rejected.length, 1);
      assert.equal(body.rejected[0].id, "model-preferences");
      assert.match(body.rejected[0].reason, /Unknown model phase/);
    } finally {
      await app.close();
    }
  });

  it("rejects model preferences with an unknown model", async () => {
    const app = await createTestApp();
    try {
      const invalidData = structuredClone(validPreferencesData);
      invalidData.modelPerPhase.implement.primary = "non-existent-gpt";

      const res = await app.inject({
        method: "POST",
        url: "/sync/push",
        headers: {
          authorization: `Bearer ${TEST_TOKEN}`,
        },
        payload: {
          changes: [
            {
              kind: "preference",
              id: "model-preferences",
              version: 1,
              data: invalidData,
            },
          ],
        },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.deepEqual(body.accepted, []);
      assert.equal(body.rejected.length, 1);
      assert.equal(body.rejected[0].id, "model-preferences");
      assert.match(body.rejected[0].reason, /references unknown model/);
    } finally {
      await app.close();
    }
  });

  it("rejects model preferences missing a required phase", async () => {
    const app = await createTestApp();
    try {
      const invalidData = {
        modelPerPhase: {
          plan: validPreferencesData.modelPerPhase.plan,
        },
      };

      const res = await app.inject({
        method: "POST",
        url: "/sync/push",
        headers: {
          authorization: `Bearer ${TEST_TOKEN}`,
        },
        payload: {
          changes: [
            {
              kind: "preference",
              id: "model-preferences",
              version: 1,
              data: invalidData,
            },
          ],
        },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.deepEqual(body.accepted, []);
      assert.equal(body.rejected.length, 1);
      assert.match(body.rejected[0].reason, /Missing model phase/);
    } finally {
      await app.close();
    }
  });

  it("accepts non-model preferences without model validation", async () => {
    const app = await createTestApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/sync/push",
        headers: {
          authorization: `Bearer ${TEST_TOKEN}`,
        },
        payload: {
          changes: [
            {
              kind: "preference",
              id: "client-theme",
              version: 1,
              data: { theme: "dark" },
            },
          ],
        },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.deepEqual(body.accepted, ["client-theme"]);
      assert.deepEqual(body.rejected, []);
    } finally {
      await app.close();
    }
  });

  it("accepts higher version and rejects stale version", async () => {
    const app = await createTestApp();
    try {
      // 1. First push v1
      const res1 = await app.inject({
        method: "POST",
        url: "/sync/push",
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
        payload: {
          changes: [
            {
              kind: "preference",
              id: "model-preferences",
              version: 1,
              data: validPreferencesData,
            },
          ],
        },
      });
      assert.deepEqual(res1.json().accepted, ["model-preferences"]);

      // 2. Push higher version v2 -> accepted
      const res2 = await app.inject({
        method: "POST",
        url: "/sync/push",
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
        payload: {
          changes: [
            {
              kind: "preference",
              id: "model-preferences",
              version: 2,
              data: validPreferencesData,
            },
          ],
        },
      });
      assert.deepEqual(res2.json().accepted, ["model-preferences"]);

      // 3. Push stale version v1 -> rejected as stale
      const res3 = await app.inject({
        method: "POST",
        url: "/sync/push",
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
        payload: {
          changes: [
            {
              kind: "preference",
              id: "model-preferences",
              version: 1,
              data: validPreferencesData,
            },
          ],
        },
      });
      assert.deepEqual(res3.json().accepted, []);
      assert.deepEqual(res3.json().rejected, [{ id: "model-preferences", reason: "stale" }]);
    } finally {
      await app.close();
    }
  });
});
