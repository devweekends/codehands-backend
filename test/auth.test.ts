
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import type pg from "pg";
import { authRoutes, hashToken } from "../src/auth.js";

const USER_ID = "user-123";
const DEVICE_ID = "device-123";

function createPoolMock(): pg.Pool {
  return {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes("insert into users")) {
        return {
          rows: [{ id: USER_ID }],
          rowCount: 1,
        };
      }

      if (sql.includes("insert into devices")) {
        return {
          rows: [{
            id: DEVICE_ID,
            name: values?.[1],
            created_at: "2026-11-03T10:00:00.000Z",
          }],
          rowCount: 1,
        };
      }

      throw new Error(`Unexpected database query: ${sql}`);
    },
  } as unknown as pg.Pool;
}

function githubFetchMock(
  responses: Array<{ body: unknown; status?: number }>
): typeof fetch {
  let index = 0;

  return async () => {
    const response = responses[index++];

    if (!response) {
      throw new Error("Unexpected GitHub request");
    }

    return new Response(JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
}

async function createTestApp(fetchImpl: typeof fetch) {
  const app = Fastify();

  await app.register(authRoutes, {
    pool: createPoolMock(),
    fetchImpl,
  });

  return app;
}

describe("GitHub authentication", () => {
  it("successfully signs in and stores only the device token hash", async () => {
    const app = await createTestApp(
      githubFetchMock([
        { body: { access_token: "fake-github-token" } },
        { body: { id: 12345, login: "test-user" } },
      ])
    );

    try {
      const response = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: {
          githubCode: "fake-code",
          deviceName: "Test Laptop",
        },
      });

      assert.equal(response.statusCode, 200);

      const result = response.json();

      assert.equal(result.userId, USER_ID);
      assert.equal(result.device.id, DEVICE_ID);
      assert.equal(result.device.name, "Test Laptop");
      assert.equal(typeof result.deviceToken, "string");
      assert.equal(result.deviceToken.length, 64);
      assert.equal(
        hashToken(result.deviceToken).length,
        64
      );
    } finally {
      await app.close();
    }
  });

  it("rejects an invalid or expired GitHub authorization code", async () => {
    const app = await createTestApp(
      githubFetchMock([
        { body: { error: "bad_verification_code" } },
      ])
    );

    try {
      const response = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: {
          githubCode: "invalid-code",
          deviceName: "Test Laptop",
        },
      });

      assert.equal(response.statusCode, 401);
      assert.match(
        response.json().error,
        /invalid or expired/
      );
    } finally {
      await app.close();
    }
  });

  it("returns 502 when GitHub is unavailable", async () => {
    const app = await createTestApp(async () => {
      throw new Error("Network failure");
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: {
          githubCode: "fake-code",
          deviceName: "Test Laptop",
        },
      });

      assert.equal(response.statusCode, 502);
    } finally {
      await app.close();
    }
  });

  it("rejects an invalid GitHub user response", async () => {
    const app = await createTestApp(
      githubFetchMock([
        { body: { access_token: "fake-github-token" } },
        { body: { id: "not-a-number", login: "test-user" } },
      ])
    );

    try {
      const response = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: {
          githubCode: "fake-code",
          deviceName: "Test Laptop",
        },
      });

      assert.equal(response.statusCode, 502);
    } finally {
      await app.close();
    }
  });

  it("rejects missing login fields", async () => {
    const app = await createTestApp(async () => {
      throw new Error("GitHub should not be called");
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: {
          githubCode: "",
          deviceName: "Test Laptop",
        },
      });

      assert.equal(response.statusCode, 400);
    } finally {
      await app.close();
    }
  });
});
