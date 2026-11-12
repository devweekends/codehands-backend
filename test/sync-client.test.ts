import test from "node:test";
import assert from "node:assert/strict";
import { createSyncClient, SyncAuthError, SyncRequestError } from "../src/sync-client.js";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const base = { baseUrl: "http://x", getToken: () => "t", retryDelayMs: 1 };

test("retries a 500 and then succeeds", async () => {
  let calls = 0;
  const c = createSyncClient({
    ...base,
    fetchImpl: (async () => (++calls < 3 ? json(500, {}) : json(200, { accepted: ["a"], rejected: [] }))) as typeof fetch,
  });
  const r = await c.push([{ kind: "preference", id: "a", version: 1, data: {} }]);
  assert.deepEqual(r.accepted, ["a"]);
  assert.equal(calls, 3);
});

test("does not retry a 400", async () => {
  let calls = 0;
  const c = createSyncClient({ ...base, fetchImpl: (async () => (calls++, json(400, {}))) as typeof fetch });
  await assert.rejects(c.pull(null), SyncRequestError);
  assert.equal(calls, 1);
});

test("401 throws SyncAuthError and does not retry", async () => {
  let calls = 0;
  const c = createSyncClient({ ...base, fetchImpl: (async () => (calls++, json(401, {}))) as typeof fetch });
  await assert.rejects(c.pull(null), SyncAuthError);
  assert.equal(calls, 1);
});

test("pullAll follows hasMore", async () => {
  const pages = [
    { changes: [{ kind: "preference", id: "a", version: 1, data: {} }], nextCursor: "1", hasMore: true },
    { changes: [{ kind: "preference", id: "b", version: 1, data: {} }], nextCursor: "2", hasMore: false },
  ];
  let i = 0;
  const c = createSyncClient({ ...base, fetchImpl: (async () => json(200, pages[i++])) as typeof fetch });
  const r = await c.pullAll(null);
  assert.equal(r.changes.length, 2);
  assert.equal(r.nextCursor, "2");
});