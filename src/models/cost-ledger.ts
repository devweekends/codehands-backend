import type { ModelRegistry } from "./model.types.js";
import type { ModelPhase } from "./model-preferences.types.js";
import type { SyncChange } from "../sync-client.js";

export interface TokenUsage {
  input: number;
  outputTokens: number;
  output?: number;
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
}

export interface CostLedgerRecord {
  sessionId: string;
  step: ModelPhase;
  modelId: string;
  tokens: {
    input: number;
    outputTokens: number;
    cacheRead?: number;
    cacheWrite5m?: number;
    cacheWrite1h?: number;
  };
  costUsd: number;
  createdAt: string;
}

export function costOf(
  modelId: string,
  usage: TokenUsage,
  registry: ModelRegistry,
): number {
  const model = registry.models.find((m) => m.id === modelId);
  if (!model) {
    throw new Error(`Model not found in registry: ${modelId}`);
  }

  const input = usage.input;
  const output = usage.outputTokens ?? usage.output ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite5m = usage.cacheWrite5m ?? 0;
  const cacheWrite1h = usage.cacheWrite1h ?? 0;

  if (
    input < 0 ||
    output < 0 ||
    cacheRead < 0 ||
    cacheWrite5m < 0 ||
    cacheWrite1h < 0
  ) {
    throw new Error("Token counts must be non-negative");
  }

  const p = model.pricing;
  const inCost = (input * p.inputPerMillion) / 1e6;
  const outCost = (output * p.outputPerMillion) / 1e6;
  const crCost = (cacheRead * (p.cacheReadPerMillion ?? 0)) / 1e6;
  const cw5mCost = (cacheWrite5m * (p.cacheWrite5mPerMillion ?? 0)) / 1e6;
  const cw1hCost = (cacheWrite1h * (p.cacheWrite1hPerMillion ?? 0)) / 1e6;

  const total = inCost + outCost + crCost + cw5mCost + cw1hCost;
  return Number(total.toFixed(7));
}

export function costPerSession(
  sessionId: string,
  records: CostLedgerRecord[],
): number {
  const total = records
    .filter((r) => r.sessionId === sessionId)
    .reduce((sum, r) => sum + r.costUsd, 0);
  return Number(total.toFixed(7));
}

export function costPerPhase(
  sessionId: string,
  phase: ModelPhase,
  records: CostLedgerRecord[],
): number {
  const total = records
    .filter((r) => r.sessionId === sessionId && r.step === phase)
    .reduce((sum, r) => sum + r.costUsd, 0);
  return Number(total.toFixed(7));
}

export function costBreakdownByPhase(
  sessionId: string,
  records: CostLedgerRecord[],
): Record<ModelPhase, number> {
  const breakdown: Partial<Record<ModelPhase, number>> = {};
  for (const r of records) {
    if (r.sessionId === sessionId) {
      breakdown[r.step] = (breakdown[r.step] ?? 0) + r.costUsd;
    }
  }

  const result = {} as Record<ModelPhase, number>;
  for (const [phase, cost] of Object.entries(breakdown)) {
    result[phase as ModelPhase] = Number(cost.toFixed(7));
  }
  return result;
}

export function toSyncChange(
  record: CostLedgerRecord,
  seq: number,
): SyncChange {
  const tokens: Record<string, number> = {
    input: record.tokens.input,
    outputTokens: record.tokens.outputTokens,
  };
  if (record.tokens.cacheRead !== undefined) {
    tokens.cacheRead = record.tokens.cacheRead;
  }
  if (record.tokens.cacheWrite5m !== undefined) {
    tokens.cacheWrite5m = record.tokens.cacheWrite5m;
  }
  if (record.tokens.cacheWrite1h !== undefined) {
    tokens.cacheWrite1h = record.tokens.cacheWrite1h;
  }

  return {
    kind: "event",
    id: `${record.sessionId}:cost:${seq}`,
    version: seq,
    data: {
      type: "cost.recorded",
      sessionId: record.sessionId,
      step: record.step,
      modelId: record.modelId,
      tokens,
      costUsd: record.costUsd,
      createdAt: record.createdAt,
    },
  };
}

export function fromSyncChange(change: SyncChange): CostLedgerRecord | null {
  if (change.kind !== "event") return null;
  const d = change.data as Record<string, unknown>;
  if (d?.type !== "cost.recorded") return null;

  const rawTokens = (d.tokens ?? {}) as Record<string, unknown>;
  const tokens: CostLedgerRecord["tokens"] = {
    input: Number(rawTokens.input ?? 0),
    outputTokens: Number(rawTokens.outputTokens ?? rawTokens.output ?? 0),
  };
  if (rawTokens.cacheRead !== undefined) {
    tokens.cacheRead = Number(rawTokens.cacheRead);
  }
  if (rawTokens.cacheWrite5m !== undefined) {
    tokens.cacheWrite5m = Number(rawTokens.cacheWrite5m);
  }
  if (rawTokens.cacheWrite1h !== undefined) {
    tokens.cacheWrite1h = Number(rawTokens.cacheWrite1h);
  }

  return {
    sessionId: String(d.sessionId),
    step: d.step as ModelPhase,
    modelId: String(d.modelId),
    tokens,
    costUsd: Number(d.costUsd),
    createdAt: String(d.createdAt),
  };
}
