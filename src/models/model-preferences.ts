
import type { ModelRegistry } from "./model.types.js";

import {
  MODEL_PHASES,
  type ModelPhase,
  type ModelPreferences,
  type PhaseModelPreference,
} from "./model-preferences.types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function validateModelId(
  value: unknown,
  field: string,
  availableModelIds: Set<string>,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }

  const modelId = value.trim();

  if (!availableModelIds.has(modelId)) {
    throw new Error(`${field} references unknown model: ${modelId}`);
  }

  return modelId;
}

function validatePhasePreference(
  value: unknown,
  phase: ModelPhase,
  availableModelIds: Set<string>,
): PhaseModelPreference {
  if (!isRecord(value)) {
    throw new Error(`${phase} preference must be an object`);
  }

  const primary = validateModelId(
    value.primary,
    `${phase}.primary`,
    availableModelIds,
  );

  if (!Array.isArray(value.backups)) {
    throw new Error(`${phase}.backups must be an array`);
  }

  const backups = value.backups.map((backup, index) =>
    validateModelId(
      backup,
      `${phase}.backups[${index}]`,
      availableModelIds,
    ),
  );

  if (new Set(backups).size !== backups.length) {
    throw new Error(`${phase}.backups must not contain duplicates`);
  }

  if (backups.includes(primary)) {
    throw new Error(
      `${phase}.primary must not also appear in backups`,
    );
  }

  return {
    primary,
    backups,
  };
}

export function validateModelPreferences(
  data: unknown,
  registry: ModelRegistry,
): ModelPreferences {
  if (!isRecord(data)) {
    throw new Error("Model preferences must be an object");
  }

  if (!isRecord(data.modelPerPhase)) {
    throw new Error("modelPerPhase must be an object");
  }

  const phaseData = data.modelPerPhase;

  for (const key of Object.keys(phaseData)) {
    if (!(MODEL_PHASES as readonly string[]).includes(key)) {
      throw new Error(`Unknown model phase: ${key}`);
    }
  }

  const availableModelIds = new Set(
    registry.models.map((model) => model.id),
  );

  const modelPerPhase = {} as ModelPreferences["modelPerPhase"];

  for (const phase of MODEL_PHASES) {
    if (!(phase in phaseData)) {
      throw new Error(`Missing model phase: ${phase}`);
    }

    modelPerPhase[phase] = validatePhasePreference(
      phaseData[phase],
      phase,
      availableModelIds,
    );
  }

  return { modelPerPhase };
}
