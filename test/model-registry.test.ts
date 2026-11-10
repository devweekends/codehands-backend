import test from "node:test";
import assert from "node:assert/strict";

import {
  validateModelRegistry,
  loadModelRegistry,
} from "../src/models/model-registry.js";

const validModel = {
  id: "test-model",
  provider: "test-provider",

  pricing: {
    input_per_million: 2,
    output_per_million: 8,
    cache_read_per_million: 0.5,
    cache_write_5m_per_million: 1,
    cache_write_1h_per_million: 2,
  },

  context_size: 200000,

  capabilities: [
    "reasoning",
    "coding",
    "analysis",
  ],

  pricing_source: "https://example.com/pricing",
  pricing_verified_at: "2026-11-08",
};

test("accepts a valid model registry", () => {
  const result = validateModelRegistry({
    models: [validModel],
  });

  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].id, "test-model");
  assert.equal(result.models[0].provider, "test-provider");
  assert.equal(result.models[0].contextSize, 200000);
  assert.deepEqual(result.models[0].capabilities, [
    "reasoning",
    "coding",
    "analysis",
  ]);
});

test("converts YAML pricing fields to camelCase", () => {
  const result = validateModelRegistry({
    models: [validModel],
  });

  assert.deepEqual(result.models[0].pricing, {
    inputPerMillion: 2,
    outputPerMillion: 8,
    cacheReadPerMillion: 0.5,
    cacheWrite5mPerMillion: 1,
    cacheWrite1hPerMillion: 2,
  });
});

test("accepts an empty registry", () => {
  const result = validateModelRegistry({ models: [] });

  assert.deepEqual(result, { models: [] });
});

test("rejects a registry without a models array", () => {
  assert.throws(
    () => validateModelRegistry({}),
    /models array/,
  );
});

test("rejects a model without an ID", () => {
  const { id, ...modelWithoutId } = validModel;

  assert.throws(
    () => validateModelRegistry({ models: [modelWithoutId] }),
    /Model id/,
  );
});

test("rejects missing input pricing", () => {
  const model = {
    ...validModel,
    pricing: {
      output_per_million: 8,
    },
  };

  assert.throws(
    () => validateModelRegistry({ models: [model] }),
    /input_per_million/,
  );
});

test("rejects missing output pricing", () => {
  const model = {
    ...validModel,
    pricing: {
      input_per_million: 2,
    },
  };

  assert.throws(
    () => validateModelRegistry({ models: [model] }),
    /output_per_million/,
  );
});

test("rejects negative prices", () => {
  const model = {
    ...validModel,
    pricing: {
      ...validModel.pricing,
      input_per_million: -2,
    },
  };

  assert.throws(
    () => validateModelRegistry({ models: [model] }),
    /non-negative number/,
  );
});

test("rejects negative optional cache prices", () => {
  const model = {
    ...validModel,
    pricing: {
      ...validModel.pricing,
      cache_read_per_million: -0.5,
    },
  };

  assert.throws(
    () => validateModelRegistry({ models: [model] }),
    /non-negative number/,
  );
});

test("rejects duplicate model IDs", () => {
  assert.throws(
    () =>
      validateModelRegistry({
        models: [validModel, validModel],
      }),
    /Duplicate model id/,
  );
});

test("rejects an invalid pricing source URL", () => {
  const model = {
    ...validModel,
    pricing_source: "not-a-url",
  };

  assert.throws(
    () => validateModelRegistry({ models: [model] }),
    /valid HTTP\(S\) URL/,
  );
});

test("rejects an invalid calendar date", () => {
  const model = {
    ...validModel,
    pricing_verified_at: "2026-02-31",
  };

  assert.throws(
    () => validateModelRegistry({ models: [model] }),
    /valid YYYY-MM-DD date/,
  );
});

test("rejects a non-positive context size", () => {
  const model = {
    ...validModel,
    context_size: 0,
  };

  assert.throws(
    () => validateModelRegistry({ models: [model] }),
    /positive integer/,
  );
});

test("rejects a non-integer context size", () => {
  const model = {
    ...validModel,
    context_size: 200000.5,
  };

  assert.throws(
    () => validateModelRegistry({ models: [model] }),
    /positive integer/,
  );
});

test("rejects missing capabilities", () => {
  const { capabilities, ...modelWithoutCapabilities } = validModel;

  assert.throws(
    () => validateModelRegistry({
      models: [modelWithoutCapabilities],
    }),
    /capabilities must be an array/,
  );
});

test("rejects empty capability names", () => {
  const model = {
    ...validModel,
    capabilities: ["coding", "  "],
  };

  assert.throws(
    () => validateModelRegistry({ models: [model] }),
    /non-empty string/,
  );
});

test("rejects duplicate capabilities", () => {
  const model = {
    ...validModel,
    capabilities: ["coding", "coding"],
  };

  assert.throws(
    () => validateModelRegistry({ models: [model] }),
    /must not contain duplicates/,
  );
});

test("loads the default YAML registry", async () => {
  const result = await loadModelRegistry();

  assert.ok(result.models.length >= 1);
  assert.equal(result.models[0].id, "claude-opus-5-5");
  assert.equal(result.models[0].provider, "anthropic");
});
