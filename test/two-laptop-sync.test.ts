import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import type pg from "pg";
import { syncRoutes } from "../src/sync.js";
import { createSyncClient } from "../src/sync-client.js";
import { hashToken } from "../src/auth.js";
import {
  toSyncChange,
  fromSyncChange,
  costPerSession,
  type CostLedgerRecord,
} from "../src/models/cost-ledger.js";

const TOKEN_A = "token-laptop-a-1234567890123456789012";
const TOKEN_B = "token-laptop-b-1234567890123456789012";
const TOKEN_USER2 = "token-laptop-c-user2-123456789012345";

const USER_1 = "user-team-lead";
const USER_2 = "user-other-person";

const DEVICE_A = "device-laptop-a";
const DEVICE_B = "device-laptop-b";
const DEVICE_C = "device-laptop-c";

interface RecordRow {
  user_id: string;
  kind: string;
  id: string;
  version: number;
  deleted: boolean;
  data: Record<string, unknown>;
  seq: number;
}

function createTwoLaptopMockPool() {
  let globalSeq = 0;
  const store = new Map<string, RecordRow>();

  const tokenDeviceMap = new Map<string, { id: string; user_id: string }>([
    [hashToken(TOKEN_A), { id: DEVICE_A, user_id: USER_1 }],
    [hashToken(TOKEN_B), { id: DEVICE_B, user_id: USER_1 }],
    [hashToken(TOKEN_USER2), { id: DEVICE_C, user_id: USER_2 }],
  ]);

  return {
    query: async (sql: string, values?: unknown[]) => {
      // 1. Auth check
      if (sql.includes("from devices where token_hash")) {
        const hash = values?.[0] as string;
        const device = tokenDeviceMap.get(hash);
        if (device) {
          return { rows: [device], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      // 2. Device touch
      if (sql.includes("update devices set last_seen_at")) {
        return { rows: [], rowCount: 1 };
      }

      // 3. Event insert (on conflict do nothing)
      if (sql.includes("insert into records (user_id, kind, id, version, data, device_id)")) {
        const userId = values?.[0] as string;
        const kind = values?.[1] as string;
        const id = values?.[2] as string;
        const version = Number(values?.[3]);
        const data = JSON.parse(values?.[4] as string);

        const key = `${userId}:${kind}:${id}`;
        if (!store.has(key)) {
          globalSeq++;
          store.set(key, {
            user_id: userId,
            kind,
            id,
            version,
            deleted: false,
            data,
            seq: globalSeq,
          });
        }
        return { rowCount: 1, rows: [] };
      }

      // 4. Preference/other insert (on conflict do update ... where version < excluded.version)
      if (sql.includes("on conflict (user_id, kind, id) do update set")) {
        const userId = values?.[0] as string;
        const kind = values?.[1] as string;
        const id = values?.[2] as string;
        const version = Number(values?.[3]);
        const deleted = Boolean(values?.[4]);
        const data = JSON.parse(values?.[5] as string);

        const key = `${userId}:${kind}:${id}`;
        const existing = store.get(key);

        if (!existing) {
          globalSeq++;
          store.set(key, {
            user_id: userId,
            kind,
            id,
            version,
            deleted,
            data,
            seq: globalSeq,
          });
          return { rowCount: 1, rows: [] };
        }

        if (version > existing.version) {
          globalSeq++;
          store.set(key, {
            user_id: userId,
            kind,
            id,
            version,
            deleted,
            data,
            seq: globalSeq,
          });
          return { rowCount: 1, rows: [] };
        }

        return { rowCount: 0, rows: [] };
      }

      // 5. Query existing version on conflict
      if (sql.includes("select version from records where user_id")) {
        const userId = values?.[0] as string;
        const kind = values?.[1] as string;
        const id = values?.[2] as string;
        const key = `${userId}:${kind}:${id}`;
        const existing = store.get(key);
        return {
          rows: existing ? [{ version: existing.version }] : [],
          rowCount: existing ? 1 : 0,
        };
      }

      // 6. Pull records
      if (sql.includes("select kind, id, version, deleted, data, seq from records")) {
        const userId = values?.[0] as string;
        const cursor = Number(values?.[1] ?? 0);

        const userRecords = Array.from(store.values())
          .filter((r) => r.user_id === userId && r.seq > cursor)
          .sort((a, b) => a.seq - b.seq)
          .slice(0, 500);

        return {
          rows: userRecords,
          rowCount: userRecords.length,
        };
      }

      throw new Error(`Unhandled mock query: ${sql}`);
    },
  } as unknown as pg.Pool;
}

describe("Two-laptop proof: settings, ledger rows, isolation & batching", () => {
  it("Laptop A saves settings and ledger rows, Laptop B pulls and reconstructs them", async () => {
    const app = Fastify();
    await app.register(syncRoutes, { pool: createTwoLaptopMockPool() });

    const fetchInject = (async (url: string, init: RequestInit = {}) => {
      const parsed = new URL(url);
      const res = await app.inject({
        method: (init.method as "GET" | "POST") ?? "GET",
        url: parsed.pathname + parsed.search,
        headers: init.headers as Record<string, string>,
        payload: init.body ? JSON.parse(init.body as string) : undefined,
      });

      return new Response(res.body, {
        status: res.statusCode,
        headers: res.headers as HeadersInit,
      });
    }) as typeof fetch;

    const laptopA = createSyncClient({
      baseUrl: "http://localhost:3000",
      getToken: () => TOKEN_A,
      fetchImpl: fetchInject,
    });

    const laptopB = createSyncClient({
      baseUrl: "http://localhost:3000",
      getToken: () => TOKEN_B,
      fetchImpl: fetchInject,
    });

    const laptopC_User2 = createSyncClient({
      baseUrl: "http://localhost:3000",
      getToken: () => TOKEN_USER2,
      fetchImpl: fetchInject,
    });

    try {
      // 1. Laptop A saves model preference setting
      const prefSetting = {
        kind: "preference" as const,
        id: "model-preferences",
        version: 1,
        data: {
          modelPerPhase: {
            analyze: { primary: "claude-opus-5-5", backups: [] },
            plan: { primary: "claude-opus-5-5", backups: [] },
            implement: { primary: "claude-opus-5-5", backups: [] },
            review: { primary: "claude-opus-5-5", backups: [] },
          },
        },
      };

      // Laptop A creates 5 ledger calls for session "sess-alpha"
      const ledgerRows: CostLedgerRecord[] = [
        {
          sessionId: "sess-alpha",
          step: "analyze",
          modelId: "claude-opus-5-5",
          tokens: { input: 100, outputTokens: 50 },
          costUsd: 0.0014,
          createdAt: "2026-11-10T10:00:00Z",
        },
        {
          sessionId: "sess-alpha",
          step: "plan",
          modelId: "claude-opus-5-5",
          tokens: { input: 500, outputTokens: 200 },
          costUsd: 0.006,
          createdAt: "2026-11-10T10:01:00Z",
        },
        {
          sessionId: "sess-alpha",
          step: "implement",
          modelId: "claude-opus-5-5",
          tokens: { input: 1000, outputTokens: 800 },
          costUsd: 0.02,
          createdAt: "2026-11-10T10:02:00Z",
        },
        {
          sessionId: "sess-alpha",
          step: "implement",
          modelId: "claude-opus-5-5",
          tokens: { input: 2000, outputTokens: 1500 },
          costUsd: 0.038,
          createdAt: "2026-11-10T10:03:00Z",
        },
        {
          sessionId: "sess-alpha",
          step: "review",
          modelId: "claude-opus-5-5",
          tokens: { input: 800, outputTokens: 300 },
          costUsd: 0.0092,
          createdAt: "2026-11-10T10:04:00Z",
        },
      ];

      const ledgerChanges = ledgerRows.map((row, idx) => toSyncChange(row, idx + 1));

      // Laptop A pushes preferences + ledger records
      const pushRes = await laptopA.push([prefSetting, ...ledgerChanges]);
      assert.equal(pushRes.accepted.length, 6);
      assert.equal(pushRes.rejected.length, 0);

      // 2. Laptop B pulls all records
      const pulledB = await laptopB.pullAll(null);
      assert.equal(pulledB.changes.length, 6);

      // Verify preference setting synced to B
      const syncedPref = pulledB.changes.find((c) => c.id === "model-preferences");
      assert.ok(syncedPref);
      assert.deepEqual(syncedPref.data, prefSetting.data);

      // Verify ledger records synced to B and can reconstruct cost
      const pulledLedger = pulledB.changes
        .map(fromSyncChange)
        .filter((r): r is CostLedgerRecord => r !== null);

      assert.equal(pulledLedger.length, 5);
      const sessionCostOnLaptopB = costPerSession("sess-alpha", pulledLedger);
      const sessionCostOnLaptopA = costPerSession("sess-alpha", ledgerRows);
      assert.equal(sessionCostOnLaptopB, sessionCostOnLaptopA);
      assert.equal(sessionCostOnLaptopB, 0.0746);

      // 3. Stale rejection: Laptop A updates to v2, then Laptop B tries pushing stale v1
      const prefV2 = { ...prefSetting, version: 2 };
      const pushV2 = await laptopA.push([prefV2]);
      assert.deepEqual(pushV2.accepted, ["model-preferences"]);

      const stalePush = await laptopB.push([prefSetting]); // version 1
      assert.deepEqual(stalePush.accepted, []);
      assert.deepEqual(stalePush.rejected, [{ id: "model-preferences", reason: "stale" }]);

      // 4. Second user isolation: User 2 pulls and sees 0 records
      const pulledUser2 = await laptopC_User2.pullAll(null);
      assert.equal(pulledUser2.changes.length, 0);

      // 5. Batch over 500 records: push 505 records from Laptop A
      const largeBatch = Array.from({ length: 505 }, (_, i) => ({
        kind: "event" as const,
        id: `sess-large:cost:${i + 1}`,
        version: i + 1,
        data: {
          type: "cost.recorded",
          index: i + 1,
          costUsd: 0.001,
        },
      }));

      const largePushRes = await laptopA.push(largeBatch);
      assert.equal(largePushRes.accepted.length, 505);
      assert.equal(largePushRes.rejected.length, 0);

      // Laptop B pulls all and paginates through cursor
      const pulledAfterLarge = await laptopB.pullAll(null);
      // Previous 6 + 505 = 511 total records
      assert.equal(pulledAfterLarge.changes.length, 511);
    } finally {
      await app.close();
    }
  });
});
