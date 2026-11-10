export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion?: number;
  cacheWrite5mPerMillion?: number;
  cacheWrite1hPerMillion?: number;
}

export interface ModelDefinition {
  id: string;
  provider: string;
  pricing: ModelPricing;
  contextSize: number;
  capabilities: string[];
  pricingSource: string;
  pricingVerifiedAt: string;
}

export interface ModelRegistry {
  models: ModelDefinition[];
}