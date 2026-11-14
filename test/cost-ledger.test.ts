import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  costOf,
  costPerSession,
  costPerPhase,
  costBreakdownByPhase,
  toSyncChange,
  fromSyncChange,
  type CostLedgerRecord,
} from "../src/models/cost-ledger.js";
import { checkData } from "../src/guard.js";
import type { ModelRegistry } from "../src/models/model.types.js";

const registry: ModelRegistry = {
  models: [
    {
      id: "claude-opus-5-5",
      provider: "anthropic",
      pricing: {
        inputPerMillion: 4.0,
        outputPerMillion: 20.0,
        cacheReadPerMillion: 0.2,
        cacheWrite5mPerMillion: 5.0,
        cacheWrite1hPerMillion: 8.0,
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
        inputPerMillion: 3.0,
        outputPerMillion: 15.0,
        cacheReadPerMillion: 0.3,
        cacheWrite5mPerMillion: 3.75,
        cacheWrite1hPerMillion: 6.0,
      },
      contextSize: 200000,
      capabilities: ["coding"],
      pricingSource: "https://example.com/pricing",
      pricingVerifiedAt: "2026-11-08",
    },
  ],
};

describe("Cost ledger and costOf calculations", () => {
  it("calculates basic input and output costs correctly", () => {
    const cost = costOf(
      "claude-sonnet-5-5",
      { input: 100000, outputTokens: 50000 },
      registry,
    );

    // 100k in = 0.30, 50k out = 0.75 -> total 1.05
    assert.equal(cost, 1.05);
  });

  it("calculates cache reads and cache writes properly", () => {
    const cost = costOf(
      "claude-sonnet-5-5",
      {
        input: 1000,
        outputTokens: 500,
        cacheRead: 10000,
        cacheWrite5m: 5000,
      },
      registry,
    );

    // in: 1000 * 3 / 1e6 = 0.003
    // out: 500 * 15 / 1e6 = 0.0075
    // cr: 10000 * 0.3 / 1e6 = 0.003
    // cw5m: 5000 * 3.75 / 1e6 = 0.01875
    // total = 0.03225
    assert.equal(cost, 0.03225);
  });

  it("matches Claude Code recorded run of 0.2768164 within 5% (exact match)", () => {
    const usage = {
      input: 10,
      outputTokens: 1092,
      cacheRead: 225842,
      cacheWrite1h: 26221,
    };

    const cost = costOf("claude-opus-5-5", usage, registry);
    const expected = 0.2768164;

    assert.equal(cost, expected);

    // Verify difference is well within 5%
    const diffPercent = Math.abs(cost - expected) / expected;
    assert.ok(diffPercent <= 0.05);
  });

  it("rejects unknown models", () => {
    assert.throws(
      () => costOf("non-existent", { input: 10, outputTokens: 10 }, registry),
      /Model not found in registry/,
    );
  });

  it("rejects negative token counts", () => {
    assert.throws(
      () =>
        costOf(
          "claude-opus-5-5",
          { input: -5, outputTokens: 10 },
          registry,
        ),
      /Token counts must be non-negative/,
    );

    assert.throws(
      () =>
        costOf(
          "claude-opus-5-5",
          { input: 5, outputTokens: 10, cacheRead: -1 },
          registry,
        ),
      /Token counts must be non-negative/,
    );
  });

  it("calculates session and phase roll-ups accurately", () => {
    const records: CostLedgerRecord[] = [
      {
        sessionId: "sess-1",
        step: "analyze",
        modelId: "claude-sonnet-5-5",
        tokens: { input: 1000, outputTokens: 100 },
        costUsd: 0.05,
        createdAt: "2026-11-10T10:00:00Z",
      },
      {
        sessionId: "sess-1",
        step: "plan",
        modelId: "claude-opus-5-5",
        tokens: { input: 2000, outputTokens: 200 },
        costUsd: 0.15,
        createdAt: "2026-11-10T10:01:00Z",
      },
      {
        sessionId: "sess-1",
        step: "implement",
        modelId: "claude-opus-5-5",
        tokens: { input: 5000, outputTokens: 500 },
        costUsd: 0.35,
        createdAt: "2026-11-10T10:02:00Z",
      },
      {
        sessionId: "sess-2",
        step: "analyze",
        modelId: "claude-sonnet-5-5",
        tokens: { input: 1000, outputTokens: 100 },
        costUsd: 0.08,
        createdAt: "2026-11-10T10:03:00Z",
      },
    ];

    assert.equal(costPerSession("sess-1", records), 0.55);
    assert.equal(costPerSession("sess-2", records), 0.08);
    assert.equal(costPerSession("sess-3", records), 0);

    assert.equal(costPerPhase("sess-1", "analyze", records), 0.05);
    assert.equal(costPerPhase("sess-1", "plan", records), 0.15);
    assert.equal(costPerPhase("sess-1", "implement", records), 0.35);
    assert.equal(costPerPhase("sess-1", "review", records), 0);

    const breakdown = costBreakdownByPhase("sess-1", records);
    assert.deepEqual(breakdown, {
      analyze: 0.05,
      plan: 0.15,
      implement: 0.35,
    });
  });

  it("converts ledger record to SyncChange without triggering forbidden guard fields", () => {
    const record: CostLedgerRecord = {
      sessionId: "sess-100",
      step: "implement",
      modelId: "claude-opus-5-5",
      tokens: {
        input: 10,
        outputTokens: 1092,
        cacheRead: 225842,
        cacheWrite1h: 26221,
      },
      costUsd: 0.2768164,
      createdAt: "2026-11-10T10:30:00Z",
    };

    const change = toSyncChange(record, 1);
    assert.equal(change.kind, "event");
    assert.equal(change.id, "sess-100:cost:1");

    // Must pass checkData without "forbidden_field" or "too_large"
    const guardCheck = checkData(change.data);
    assert.equal(guardCheck, null);

    // Reconstruct ledger record from sync change
    const restored = fromSyncChange(change);
    assert.deepEqual(restored, record);
  });
});
