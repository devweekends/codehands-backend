import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import type {
  ModelDefinition,
  ModelRegistry,
  ModelPricing,
} from "./model.types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function validateString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }

  return value.trim();
}

function validatePrice(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0
  ) {
    throw new Error(`${field} must be a non-negative number`);
  }

  return value;
}

function validatePricing(value: unknown): ModelPricing {
  if (!isRecord(value)) {
    throw new Error("Model pricing must be an object");
  }

  const pricing: ModelPricing = {
    inputPerMillion: validatePrice(
      value.input_per_million,
      "pricing.input_per_million",
    ),
    outputPerMillion: validatePrice(
      value.output_per_million,
      "pricing.output_per_million",
    ),
  };

  if (value.cache_read_per_million !== undefined) {
    pricing.cacheReadPerMillion = validatePrice(
      value.cache_read_per_million,
      "pricing.cache_read_per_million",
    );
  }

  if (value.cache_write_5m_per_million !== undefined) {
    pricing.cacheWrite5mPerMillion = validatePrice(
      value.cache_write_5m_per_million,
      "pricing.cache_write_5m_per_million",
    );
  }

  if (value.cache_write_1h_per_million !== undefined) {
    pricing.cacheWrite1hPerMillion = validatePrice(
      value.cache_write_1h_per_million,
      "pricing.cache_write_1h_per_million",
    );
  }

  return pricing;
}

function validateContextSize(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new Error("context_size must be a positive integer");
  }

  return value;
}

function validateCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("capabilities must be an array");
  }

  const capabilities = value.map((capability, index) =>
    validateString(capability, `capabilities[${index}]`),
  );

  if (new Set(capabilities).size !== capabilities.length) {
    throw new Error("capabilities must not contain duplicates");
  }

  return capabilities;
}

function isValidDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);

  if (year < 1 || month < 1 || month > 12 || day < 1) {
    return false;
  }

  const isLeapYear =
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

  const daysInMonth = [
    31,
    isLeapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];

  return day <= daysInMonth[month - 1];
}

function validatePricingSource(value: unknown, modelId: string): string {
  const pricingSource = validateString(
    value,
    `${modelId}.pricing_source`,
  );

  try {
    const sourceUrl = new URL(pricingSource);

    if (!["http:", "https:"].includes(sourceUrl.protocol)) {
      throw new Error();
    }
  } catch {
    throw new Error(
      `${modelId}.pricing_source must be a valid HTTP(S) URL`,
    );
  }

  return pricingSource;
}

function validateModel(value: unknown): ModelDefinition {
  if (!isRecord(value)) {
    throw new Error("Each model must be an object");
  }

  const id = validateString(value.id, "Model id");
  const provider = validateString(value.provider, `${id}.provider`);

  const pricing = validatePricing(value.pricing);
  const contextSize = validateContextSize(value.context_size);
  const capabilities = validateCapabilities(value.capabilities);

  const pricingSource = validatePricingSource(
    value.pricing_source,
    id,
  );

  const pricingVerifiedAt = validateString(
    value.pricing_verified_at,
    `${id}.pricing_verified_at`,
  );

  if (!isValidDateOnly(pricingVerifiedAt)) {
    throw new Error(
      `${id}.pricing_verified_at must use a valid YYYY-MM-DD date`,
    );
  }

  return {
    id,
    provider,
    pricing,
    contextSize,
    capabilities,
    pricingSource,
    pricingVerifiedAt,
  };
}

export function validateModelRegistry(data: unknown): ModelRegistry {
  if (!isRecord(data) || !Array.isArray(data.models)) {
    throw new Error("Registry must contain a models array");
  }

  const models: ModelDefinition[] = [];
  const modelIds = new Set<string>();

  for (const entry of data.models) {
    const model = validateModel(entry);

    if (modelIds.has(model.id)) {
      throw new Error(`Duplicate model id: ${model.id}`);
    }

    modelIds.add(model.id);
    models.push(model);
  }

  return { models };
}

const DEFAULT_REGISTRY_PATH = fileURLToPath(
  new URL("../../models.yaml", import.meta.url),
);

export async function loadModelRegistry(
  filePath: string = DEFAULT_REGISTRY_PATH,
): Promise<ModelRegistry> {
  const yamlContent = await readFile(filePath, "utf8");

  let parsedData: unknown;

  try {
    parsedData = YAML.parse(yamlContent);
  } catch (error) {
    throw new Error("Invalid YAML in model registry", {
      cause: error,
    });
  }

  return validateModelRegistry(parsedData);
}