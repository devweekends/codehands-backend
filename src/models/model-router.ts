import type {
  ModelPhase,
  ModelPreferences,
} from "./model-preferences.types.js";

export function pickModel(
  phase: ModelPhase,
  failedModels: string[],
  preferences: ModelPreferences,
): string {
  const phasePreference = preferences.modelPerPhase[phase];
  if (!phasePreference) {
    throw new Error(`No preferences configured for phase: ${phase}`);
  }

  const failedModelIds = new Set(failedModels);

  const candidates = [
    phasePreference.primary,
    ...phasePreference.backups,
  ];

  const selectedModel = candidates.find(
    (modelId) => !failedModelIds.has(modelId),
  );

  if (!selectedModel) {
    throw new Error(
      `All candidate models for phase "${phase}" have failed: ${candidates.join(", ")}`,
    );
  }

  return selectedModel;
}
