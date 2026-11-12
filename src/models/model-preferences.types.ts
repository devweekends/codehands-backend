export const MODEL_PHASES = [
  "analyze",
  "plan",
  "implement",
  "review",
] as const;

export type ModelPhase = (typeof MODEL_PHASES)[number];

export interface PhaseModelPreference {
  primary: string;
  backups: string[];
}

export type ModelPerPhase = Record<
  ModelPhase,
  PhaseModelPreference
>;

export interface ModelPreferences {
  modelPerPhase: ModelPerPhase;
}
