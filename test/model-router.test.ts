import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { pickModel } from "../src/models/model-router.js";

import type { ModelPreferences } from "../src/models/model-preferences.types.js";

const preferences: ModelPreferences = {
  modelPerPhase: {
    analyze: {
      primary: "model-c",
      backups: ["model-a"],
    },
    plan: {
      primary: "model-a",
      backups: ["model-b", "model-c"],
    },
    implement: {
      primary: "model-b",
      backups: ["model-a", "model-c"],
    },
    review: {
      primary: "model-a",
      backups: [],
    },
  },
};

describe("Model router", () => {
  it("selects the primary model when no models have failed", () => {
    const result = pickModel("plan", [], preferences);

    assert.equal(result, "model-a");
  });

  it("selects the first backup when the primary has failed", () => {
    const result = pickModel("plan", ["model-a"], preferences);

    assert.equal(result, "model-b");
  });

  it("selects the second backup when primary and first backup have failed", () => {
    const result = pickModel(
      "plan",
      ["model-a", "model-b"],
      preferences,
    );

    assert.equal(result, "model-c");
  });

  it("throws an error when all models for a phase have failed", () => {
    assert.throws(
      () =>
        pickModel(
          "plan",
          ["model-a", "model-b", "model-c"],
          preferences,
        ),
      /All candidate models for phase "plan" have failed/,
    );
  });

  it("selects models independently for each phase", () => {
    const result = pickModel("implement", [], preferences);

    assert.equal(result, "model-b");
  });

  it("does not select a failed model even if it is a backup", () => {
    const result = pickModel(
      "implement",
      ["model-b", "model-a"],
      preferences,
    );

    assert.equal(result, "model-c");
  });

  it("throws an error when a phase has no backups and primary has failed", () => {
    assert.throws(
      () =>
        pickModel(
          "review",
          ["model-a"],
          preferences,
        ),
      /All candidate models for phase "review" have failed/,
    );
  });

  it("does not change the original failed models array", () => {
    const failedModels = ["model-a"];
    const original = [...failedModels];

    pickModel("plan", failedModels, preferences);

    assert.deepEqual(failedModels, original);
  });

  it("preserves backup priority regardless of failure array order", () => {
    const result = pickModel(
      "plan",
      ["model-c", "model-a"],
      preferences,
    );

    assert.equal(result, "model-b");
  });

  it("selects models correctly for the analyze phase", () => {
    const result = pickModel("analyze", [], preferences);
    assert.equal(result, "model-c");

    const fallback = pickModel("analyze", ["model-c"], preferences);
    assert.equal(fallback, "model-a");
  });
});
