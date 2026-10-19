/**
 * Frozen Contract: Configuration & Validation (Phase G0)
 * Owner: Shared (Agent A + Agent B). Changes require ADR + docs/handoff.md sign-off.
 */

export type RegressionProfile = "functional" | "build";

export type FailurePolicy = "skip" | "abort" | "bad";

export type OverlayConflictPolicy = "skip" | "abort";

export interface CommandSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly cwdRelative?: string;
}

export interface BuildCommandSpec extends CommandSpec {
  readonly failurePolicy?: "skip" | "abort";
}

export type OracleMode = "in-tree" | "overlay" | "external";

export interface OracleSpec {
  readonly mode: OracleMode;
  readonly command: CommandSpec;
  readonly overlayFiles?: readonly string[];
  readonly overlayConflictPolicy?: OverlayConflictPolicy;
  readonly externalScriptPath?: string;
}

export interface ExecutionPolicy {
  readonly maxOutputBytesPerCommand: number;
  readonly maxRetries: number;
  readonly endpointFlakeRuns: number;
  readonly boundaryConfirmRuns: number;
  readonly maxSkips: number;
  readonly confirmBeforeExecutingCode: boolean;
  readonly cleanIgnored: boolean;
  readonly allowlistedEnvVars: readonly string[];
  readonly envOverrides?: Readonly<Record<string, string>>;
  readonly enforceNodeToolchainCheck?: boolean;
}

export interface BisectConfigV1 {
  readonly schemaVersion: 1;
  readonly profile: RegressionProfile;
  readonly repositoryRoot: string;
  readonly workingDirectory: string;
  readonly goodRef: string;
  readonly badRef: string;
  readonly prepare?: CommandSpec;
  readonly build?: BuildCommandSpec;
  readonly oracle: OracleSpec;
  readonly execution: ExecutionPolicy;
  readonly sessionRootDir?: string;
}

export interface ConfigValidationIssue {
  readonly path: string;
  readonly message: string;
}

export type ConfigValidationResult =
  | { readonly ok: true; readonly value: BisectConfigV1 }
  | { readonly ok: false; readonly issues: readonly ConfigValidationIssue[] };

export const DETERMINISTIC_ENV_DEFAULTS: Readonly<Record<string, string>> = Object.freeze({
  CI: "1",
  TZ: "UTC",
  LANG: "C.UTF-8",
  NO_COLOR: "1",
  FORCE_COLOR: "0",
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
});

export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = Object.freeze({
  maxOutputBytesPerCommand: 1_000_000,
  maxRetries: 0,
  endpointFlakeRuns: 3,
  boundaryConfirmRuns: 3,
  maxSkips: 10,
  confirmBeforeExecutingCode: true,
  cleanIgnored: false,
  allowlistedEnvVars: [],
  enforceNodeToolchainCheck: true,
});

function validateCommandSpec(
  raw: unknown,
  basePath: string,
  issues: ConfigValidationIssue[]
): CommandSpec | undefined {
  if (!raw || typeof raw !== "object") {
    issues.push({ path: basePath, message: "Expected command object" });
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.command !== "string" || obj.command.trim().length === 0) {
    issues.push({ path: `${basePath}.command`, message: "Command must be a non-empty string" });
  }
  if (!Array.isArray(obj.args) || !obj.args.every((item) => typeof item === "string")) {
    issues.push({ path: `${basePath}.args`, message: "Args must be an array of strings" });
  }
  const timeoutMs = obj.timeoutMs ?? 180_000;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    issues.push({ path: `${basePath}.timeoutMs`, message: "timeoutMs must be a positive number" });
  }
  if (obj.cwdRelative !== undefined && typeof obj.cwdRelative !== "string") {
    issues.push({ path: `${basePath}.cwdRelative`, message: "cwdRelative must be a string" });
  }
  if (issues.length > 0) return undefined;
  return {
    command: (obj.command as string).trim(),
    args: [...(obj.args as string[])],
    timeoutMs: timeoutMs as number,
    ...(typeof obj.cwdRelative === "string" ? { cwdRelative: obj.cwdRelative } : {}),
  };
}

export function validateConfig(raw: unknown): ConfigValidationResult {
  const issues: ConfigValidationIssue[] = [];
  if (!raw || typeof raw !== "object") {
    return { ok: false, issues: [{ path: "", message: "Config must be a non-null object" }] };
  }
  const obj = raw as Record<string, unknown>;

  if (obj.schemaVersion !== 1) {
    issues.push({ path: "schemaVersion", message: "schemaVersion must be 1" });
  }
  if (obj.profile !== "functional" && obj.profile !== "build") {
    issues.push({ path: "profile", message: 'profile must be "functional" or "build"' });
  }
  if (typeof obj.repositoryRoot !== "string" || obj.repositoryRoot.trim().length === 0) {
    issues.push({ path: "repositoryRoot", message: "repositoryRoot must be a non-empty string" });
  }
  const workingDirectory = typeof obj.workingDirectory === "string" ? obj.workingDirectory : ".";
  if (typeof obj.goodRef !== "string" || obj.goodRef.trim().length === 0) {
    issues.push({ path: "goodRef", message: "goodRef must be a non-empty string" });
  }
  if (typeof obj.badRef !== "string" || obj.badRef.trim().length === 0) {
    issues.push({ path: "badRef", message: "badRef must be a non-empty string" });
  }

  const prepare = obj.prepare !== undefined ? validateCommandSpec(obj.prepare, "prepare", issues) : undefined;
  let build: BuildCommandSpec | undefined;
  if (obj.build !== undefined) {
    const baseBuild = validateCommandSpec(obj.build, "build", issues);
    const buildObj = obj.build as Record<string, unknown>;
    const fp = buildObj?.failurePolicy ?? "skip";
    if (fp !== "skip" && fp !== "abort") {
      issues.push({ path: "build.failurePolicy", message: 'failurePolicy must be "skip" or "abort"' });
    } else if (baseBuild) {
      build = { ...baseBuild, failurePolicy: fp };
    }
  }

  let oracle: OracleSpec | undefined;
  if (!obj.oracle || typeof obj.oracle !== "object") {
    issues.push({ path: "oracle", message: "oracle configuration is required" });
  } else {
    const oObj = obj.oracle as Record<string, unknown>;
    const mode = oObj.mode;
    if (mode !== "in-tree" && mode !== "overlay" && mode !== "external") {
      issues.push({ path: "oracle.mode", message: 'oracle.mode must be "in-tree", "overlay", or "external"' });
    }
    const oCmd = validateCommandSpec(oObj.command, "oracle.command", issues);
    if (mode === "overlay") {
      if (
        !Array.isArray(oObj.overlayFiles) ||
        oObj.overlayFiles.length === 0 ||
        !oObj.overlayFiles.every((f) => typeof f === "string" && f.trim().length > 0)
      ) {
        issues.push({
          path: "oracle.overlayFiles",
          message: "overlay mode requires a non-empty array of relative file paths",
        });
      }
    }
    const conflictPolicy = oObj.overlayConflictPolicy ?? "skip";
    if (conflictPolicy !== "skip" && conflictPolicy !== "abort") {
      issues.push({
        path: "oracle.overlayConflictPolicy",
        message: 'overlayConflictPolicy must be "skip" or "abort"',
      });
    }
    if (oCmd && (mode === "in-tree" || mode === "overlay" || mode === "external")) {
      oracle = {
        mode,
        command: oCmd,
        ...(Array.isArray(oObj.overlayFiles) ? { overlayFiles: oObj.overlayFiles as string[] } : {}),
        overlayConflictPolicy: conflictPolicy as OverlayConflictPolicy,
        ...(typeof oObj.externalScriptPath === "string" ? { externalScriptPath: oObj.externalScriptPath } : {}),
      };
    }
  }

  const rawExec = (obj.execution && typeof obj.execution === "object" ? obj.execution : {}) as Record<string, unknown>;
  const execution: ExecutionPolicy = {
    maxOutputBytesPerCommand:
      typeof rawExec.maxOutputBytesPerCommand === "number"
        ? rawExec.maxOutputBytesPerCommand
        : DEFAULT_EXECUTION_POLICY.maxOutputBytesPerCommand,
    maxRetries: typeof rawExec.maxRetries === "number" ? rawExec.maxRetries : DEFAULT_EXECUTION_POLICY.maxRetries,
    endpointFlakeRuns:
      typeof rawExec.endpointFlakeRuns === "number"
        ? rawExec.endpointFlakeRuns
        : DEFAULT_EXECUTION_POLICY.endpointFlakeRuns,
    boundaryConfirmRuns:
      typeof rawExec.boundaryConfirmRuns === "number"
        ? rawExec.boundaryConfirmRuns
        : DEFAULT_EXECUTION_POLICY.boundaryConfirmRuns,
    maxSkips: typeof rawExec.maxSkips === "number" ? rawExec.maxSkips : DEFAULT_EXECUTION_POLICY.maxSkips,
    confirmBeforeExecutingCode:
      typeof rawExec.confirmBeforeExecutingCode === "boolean"
        ? rawExec.confirmBeforeExecutingCode
        : DEFAULT_EXECUTION_POLICY.confirmBeforeExecutingCode,
    cleanIgnored:
      typeof rawExec.cleanIgnored === "boolean" ? rawExec.cleanIgnored : DEFAULT_EXECUTION_POLICY.cleanIgnored,
    allowlistedEnvVars: Array.isArray(rawExec.allowlistedEnvVars)
      ? (rawExec.allowlistedEnvVars.filter((x) => typeof x === "string") as string[])
      : DEFAULT_EXECUTION_POLICY.allowlistedEnvVars,
    ...(rawExec.envOverrides && typeof rawExec.envOverrides === "object"
      ? { envOverrides: rawExec.envOverrides as Record<string, string> }
      : {}),
    enforceNodeToolchainCheck:
      typeof rawExec.enforceNodeToolchainCheck === "boolean"
        ? rawExec.enforceNodeToolchainCheck
        : DEFAULT_EXECUTION_POLICY.enforceNodeToolchainCheck,
  };

  if (execution.maxOutputBytesPerCommand <= 0) {
    issues.push({ path: "execution.maxOutputBytesPerCommand", message: "Must be > 0" });
  }
  if (execution.endpointFlakeRuns < 1) {
    issues.push({ path: "execution.endpointFlakeRuns", message: "Must be >= 1" });
  }
  if (execution.boundaryConfirmRuns < 1) {
    issues.push({ path: "execution.boundaryConfirmRuns", message: "Must be >= 1" });
  }
  if (execution.maxSkips < 0) {
    issues.push({ path: "execution.maxSkips", message: "Must be >= 0" });
  }

  if (issues.length > 0 || !oracle) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    value: {
      schemaVersion: 1,
      profile: obj.profile as RegressionProfile,
      repositoryRoot: obj.repositoryRoot as string,
      workingDirectory,
      goodRef: obj.goodRef as string,
      badRef: obj.badRef as string,
      ...(prepare ? { prepare } : {}),
      ...(build ? { build } : {}),
      oracle,
      execution,
      ...(typeof obj.sessionRootDir === "string" ? { sessionRootDir: obj.sessionRootDir } : {}),
    },
  };
}
