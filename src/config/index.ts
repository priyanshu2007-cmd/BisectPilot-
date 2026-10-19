import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  validateConfig,
  type BisectConfigV1,
  type ConfigValidationResult,
} from "../contracts/config.js";

export * from "../contracts/config.js";

export function loadConfigFromFile(filePath: string): ConfigValidationResult {
  const rawText = readFileSync(filePath, "utf-8");
  const parsed: unknown = JSON.parse(rawText);
  return validateConfig(parsed);
}

export function computeConfigHash(config: BisectConfigV1): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}
