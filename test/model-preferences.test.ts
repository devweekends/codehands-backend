import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  validateModelPreferences,
} from "../src/models/model-preferences.js";

import type { ModelRegistry } from "../src/models/model.types.js";

const registry: ModelRegistry = {
  models: [
    {
      id: "model-a",
      provider: "provider-a",
      pricing: {
        inputPerMillion: 1,
        outputPerMillion: 2,
      },
      contextSize: 100000,
      capabilities: ["coding"],
      pricingSource: "https://example.com/pricing",
      pricingVerifiedAt: "2026-11-08",
    },
    {
      id: "model-b",
      provider: "provider-b",
      pricing: {
        inputPerMillion: 3,
        outputPerMillion: 4,
      },
      contextSize: 200000,
      capabilities: ["reasoning"],
      pricingSource: "https://example.com/pricing",
      pricingVerifiedAt: "2026-11-08",
    },
    {
      id: "model-c",
      provider: "provider-c",
      pricing: {
        inputPerMillion: 5,
        outputPerMillion: 6,
      },
      contextSize: 300000,
      capabilities: ["analysis"],
      pricingSource: "https://example.com/pricing",
      pricingVerifiedAt: "2026-11-08",
    },
  ],
};

const validPreferences = {
  modelPerPhase: {
    analyze: {
      primary: "model-a",
      backups: [],
    },
    plan: {
      primary: "model-a",
      backups: ["model-b"],
    },
    implement: {
      primary: "model-b",
      backups: ["model-c"],
    },
    review: {
      primary: "model-c",
      backups: ["model-a"],
    },
  },
};

describe("Model preference validation", () => {
  it("accepts valid model preferences", () => {
    const result = validateModelPreferences(
      validPreferences,
      registry,
    );

    assert.deepEqual(result, validPreferences);
  });

  it("rejects preferences without modelPerPhase", () => {
    assert.throws(
      () => validateModelPreferences({}, registry),
      /modelPerPhase must be an object/,
    );
  });

  it("rejects missing phases", () => {
    const invalid = {
      modelPerPhase: {
        plan: validPreferences.modelPerPhase.plan,
      },
    };

    assert.throws(
      () => validateModelPreferences(invalid, registry),
      /Missing model phase/,
    );
  });

  it("rejects unknown phases", () => {
    const invalid = {
      modelPerPhase: {
        ...validPreferences.modelPerPhase,
        deployment: {
          primary: "model-a",
          backups: [],
        },
      },
    };

    assert.throws(
      () => validateModelPreferences(invalid, registry),
      /Unknown model phase/,
    );
  });

  it("rejects the old 'test' phase as an unknown phase", () => {
    const invalid = {
      modelPerPhase: {
        ...validPreferences.modelPerPhase,
        test: {
          primary: "model-a",
          backups: [],
        },
      },
    };

    assert.throws(
      () => validateModelPreferences(invalid, registry),
      /Unknown model phase: test/,
    );
  });

  it("rejects unknown primary model IDs", () => {
    const invalid = structuredClone(validPreferences);

    invalid.modelPerPhase.plan.primary = "unknown-model";

    assert.throws(
      () => validateModelPreferences(invalid, registry),
      /references unknown model/,
    );
  });

  it("rejects unknown backup model IDs", () => {
    const invalid = structuredClone(validPreferences);

    invalid.modelPerPhase.plan.backups = ["unknown-model"];

    assert.throws(
      () => validateModelPreferences(invalid, registry),
      /references unknown model/,
    );
  });

  it("rejects duplicate backup models", () => {
    const invalid = structuredClone(validPreferences);

    invalid.modelPerPhase.plan.backups = [
      "model-b",
      "model-b",
    ];

    assert.throws(
      () => validateModelPreferences(invalid, registry),
      /backups must not contain duplicates/,
    );
  });

  it("rejects primary model repeated in backups", () => {
    const invalid = structuredClone(validPreferences);

    invalid.modelPerPhase.plan.backups = [
      "model-a",
      "model-b",
    ];

    assert.throws(
      () => validateModelPreferences(invalid, registry),
      /primary must not also appear in backups/,
    );
  });

  it("rejects a missing primary model", () => {
    const invalid = structuredClone(validPreferences);

    delete (invalid.modelPerPhase.plan as { primary?: string }).primary;

    assert.throws(
      () => validateModelPreferences(invalid, registry),
      /primary must be a non-empty string/,
    );
  });

  it("rejects backups that are not an array", () => {
    const invalid = structuredClone(validPreferences);

    (invalid.modelPerPhase.plan as { backups: unknown }).backups =
      "model-b";

    assert.throws(
      () => validateModelPreferences(invalid, registry),
      /backups must be an array/,
    );
  });

  it("trims whitespace around valid model IDs", () => {
    const input = structuredClone(validPreferences);

    input.modelPerPhase.plan.primary = " model-a ";

    const result = validateModelPreferences(input, registry);

    assert.equal(
      result.modelPerPhase.plan.primary,
      "model-a",
    );
  });
});
