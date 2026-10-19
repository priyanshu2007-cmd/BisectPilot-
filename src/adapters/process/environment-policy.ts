import { DETERMINISTIC_ENV_DEFAULTS, type ExecutionPolicy } from "../../contracts/index.js";

const BASELINE_SAFE_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
] as const;

const BLOCKED_SECRET_PATTERNS = [
  /TOKEN/i,
  /SECRET/i,
  /PASSWORD/i,
  /PRIVATE_KEY/i,
  /AWS_/i,
  /GCP_/i,
  /AZURE_/i,
  /OPENAI_API_KEY/i,
  /ANTHROPIC_API_KEY/i,
  /GITHUB_TOKEN/i,
  /NPM_TOKEN/i,
];

export function isLikelySecretEnvName(name: string): boolean {
  return BLOCKED_SECRET_PATTERNS.some((re) => re.test(name));
}

export function buildRestrictedEnvironment(
  policy: ExecutionPolicy,
  parentEnv: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of BASELINE_SAFE_ENV_KEYS) {
    const val = parentEnv[key];
    if (typeof val === "string") {
      env[key] = val;
    }
  }

  Object.assign(env, DETERMINISTIC_ENV_DEFAULTS);

  for (const allowedKey of policy.allowlistedEnvVars) {
    const val = parentEnv[allowedKey];
    if (typeof val === "string") {
      env[allowedKey] = val;
    }
  }

  if (policy.envOverrides) {
    for (const [k, v] of Object.entries(policy.envOverrides)) {
      if (typeof v === "string") {
        env[k] = v;
      }
    }
  }

  return env;
}
