/**
 * Frozen Contract: Configuration & Validation (Phase G0)
 * Owner: Shared (Agent A + Agent B). Changes require ADR + docs/handoff.md sign-off.
 */

export type RegressionProfile = "functional" | "build" | "performance";

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

export interface ToolchainWrapperSpec {
  readonly command: string;
  readonly args?: readonly string[];
}

export interface CustomBisectTerms {
  readonly old: string;
  readonly new: string;
}

export interface NoisyOraclePolicy {
  readonly enabled: boolean;
  readonly maxSamplesPerRevision?: number;
  readonly confidenceThreshold?: number;
  readonly flakeRate?: number;
}

export type SandboxRuntime = "docker" | "podman";

export interface SandboxResourceLimits {
  readonly cpus: number;
  readonly memoryMb: number;
  readonly pidsLimit: number;
  readonly tmpfsMb: number;
}

/**
 * Opt-in hardened execution policy. The image must be a digest-pinned local
 * image; runtime probing never pulls images or falls back to host execution.
 */
export interface ContainerSandboxPolicy {
  readonly runtime: SandboxRuntime;
  readonly image: string;
  readonly network: "none";
  readonly resources: SandboxResourceLimits;
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
  readonly interactivePrompt?: boolean;
  readonly toolchainWrapper?: ToolchainWrapperSpec;
  readonly noisyOracle?: NoisyOraclePolicy;
  readonly sandbox?: ContainerSandboxPolicy;
}

import { validateWorkspacePath } from "../domain/workspace.js";
import type { BenchmarkSpec, BenchmarkDirection } from "../domain/benchmark.js";
export type { BenchmarkSpec, BenchmarkDirection };

export interface BisectConfigV1 {
  readonly schemaVersion: 1;
  readonly profile: RegressionProfile;
  readonly repositoryRoot: string;
  readonly workingDirectory: string;
  readonly pathScope?: readonly string[];
  readonly goodRef: string;
  readonly badRef: string;
  readonly terms?: CustomBisectTerms;
  readonly prepare?: CommandSpec;
  readonly build?: BuildCommandSpec;
  readonly oracle: OracleSpec;
  readonly execution: ExecutionPolicy;
  readonly sessionRootDir?: string;
  readonly benchmark?: BenchmarkSpec;
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

export function validateBisectTerm(term: string): { ok: boolean; reason?: string } {
  if (!term || typeof term !== "string") {
    return { ok: false, reason: "Term must be a non-empty string" };
  }
  const trimmed = term.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "Term cannot be empty or whitespace" };
  }
  if (/\s/.test(trimmed)) {
    return { ok: false, reason: "Term cannot contain whitespace" };
  }
  if (/[\x00-\x1f\x7f~^:?*\[\\@]/.test(trimmed) || trimmed.includes("..") || trimmed.includes("@{")) {
    return { ok: false, reason: `Term "${trimmed}" contains invalid Git ref characters` };
  }
  if (trimmed.startsWith("-") || trimmed.startsWith(".") || trimmed.endsWith(".")) {
    return { ok: false, reason: `Term "${trimmed}" cannot start with '-' or start/end with '.'` };
  }
  const reserved = new Set(["start", "skip", "reset", "replay", "log", "run", "view", "visualize", "help", "terms"]);
  if (reserved.has(trimmed.toLowerCase())) {
    return { ok: false, reason: `Term "${trimmed}" is a reserved Git bisect subcommand` };
  }
  return { ok: true };
}

export function parseTermsOption(
  termsArg: string
): { ok: true; value: CustomBisectTerms } | { ok: false; error: string } {
  const parts = termsArg.split(",");
  if (parts.length !== 2) {
    return { ok: false, error: 'Custom terms must be in format "<old>,<new>" (e.g. "fixed,broken" or "old,new")' };
  }
  const oldTerm = parts[0]!.trim();
  const newTerm = parts[1]!.trim();

  const oldVal = validateBisectTerm(oldTerm);
  if (!oldVal.ok) {
    return { ok: false, error: `Invalid old term "${oldTerm}": ${oldVal.reason}` };
  }
  const newVal = validateBisectTerm(newTerm);
  if (!newVal.ok) {
    return { ok: false, error: `Invalid new term "${newTerm}": ${newVal.reason}` };
  }
  if (oldTerm === newTerm) {
    return { ok: false, error: `Old and new terms cannot be identical ("${oldTerm}")` };
  }
  return { ok: true, value: { old: oldTerm, new: newTerm } };
}

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
  interactivePrompt: false,
});

const SANDBOX_IMAGE_PATTERN = /^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$/;
const SANDBOX_SECRET_ENV_PATTERN = /(TOKEN|SECRET|PASSWORD|PRIVATE_KEY|AWS_|GCP_|AZURE_|API_KEY)/i;

function isSafeRelativePath(value: string): boolean {
  const normalized = value.trim().replaceAll("\\", "/");
  if (normalized.length === 0 || normalized.includes("\0") || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return false;
  let depth = 0;
  for (const segment of normalized.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      depth -= 1;
      if (depth < 0) return false;
    } else {
      depth += 1;
    }
  }
  return depth > 0;
}

function validateSandboxPolicy(raw: unknown, issues: ConfigValidationIssue[]): ContainerSandboxPolicy | undefined {
  if (!raw || typeof raw !== "object") {
    issues.push({ path: "execution.sandbox", message: "sandbox must be an object" });
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const runtime = obj.runtime;
  if (runtime !== "docker" && runtime !== "podman") {
    issues.push({ path: "execution.sandbox.runtime", message: 'runtime must be "docker" or "podman"' });
  }
  const image = typeof obj.image === "string" ? obj.image.trim() : "";
  if (!SANDBOX_IMAGE_PATTERN.test(image)) {
    issues.push({
      path: "execution.sandbox.image",
      message: "image must be a lowercase digest-pinned reference such as ghcr.io/org/image@sha256:<64 hex chars>",
    });
  }
  if (obj.network !== undefined && obj.network !== "none") {
    issues.push({ path: "execution.sandbox.network", message: 'sandbox network policy must be "none"' });
  }
  const rawResources = obj.resources === undefined ? {} : obj.resources;
  if (!rawResources || typeof rawResources !== "object") {
    issues.push({ path: "execution.sandbox.resources", message: "resources must be an object" });
  }
  const resources = (rawResources && typeof rawResources === "object" ? rawResources : {}) as Record<string, unknown>;
  const cpus = typeof resources.cpus === "number" ? resources.cpus : 1;
  const memoryMb = typeof resources.memoryMb === "number" ? resources.memoryMb : 512;
  const pidsLimit = typeof resources.pidsLimit === "number" ? resources.pidsLimit : 256;
  const tmpfsMb = typeof resources.tmpfsMb === "number" ? resources.tmpfsMb : 128;
  if (!Number.isFinite(cpus) || cpus <= 0 || cpus > 64) issues.push({ path: "execution.sandbox.resources.cpus", message: "cpus must be > 0 and <= 64" });
  if (!Number.isInteger(memoryMb) || memoryMb < 16 || memoryMb > 65_536) issues.push({ path: "execution.sandbox.resources.memoryMb", message: "memoryMb must be an integer from 16 to 65536" });
  if (!Number.isInteger(pidsLimit) || pidsLimit < 16 || pidsLimit > 4_096) issues.push({ path: "execution.sandbox.resources.pidsLimit", message: "pidsLimit must be an integer from 16 to 4096" });
  if (!Number.isInteger(tmpfsMb) || tmpfsMb < 16 || tmpfsMb > 4_096) issues.push({ path: "execution.sandbox.resources.tmpfsMb", message: "tmpfsMb must be an integer from 16 to 4096" });
  if (runtime !== "docker" && runtime !== "podman") return undefined;
  return {
    runtime,
    image,
    network: "none",
    resources: { cpus, memoryMb, pidsLimit, tmpfsMb },
  };
}

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
  if (obj.profile !== "functional" && obj.profile !== "build" && obj.profile !== "performance") {
    issues.push({ path: "profile", message: 'profile must be "functional", "build", or "performance"' });
  }
  if (typeof obj.repositoryRoot !== "string" || obj.repositoryRoot.trim().length === 0) {

    issues.push({ path: "repositoryRoot", message: "repositoryRoot must be a non-empty string" });
  }
  const rawWorkingDir = typeof obj.workingDirectory === "string" ? obj.workingDirectory : ".";
  let workingDirectory = ".";
  if (typeof obj.repositoryRoot === "string" && obj.repositoryRoot.trim().length > 0) {
    const wsVal = validateWorkspacePath(obj.repositoryRoot, rawWorkingDir);
    if (!wsVal.ok) {
      issues.push({ path: "workingDirectory", message: wsVal.error ?? "Invalid workspace path" });
    } else {
      workingDirectory = wsVal.relativePath;
    }
  } else {
    workingDirectory = rawWorkingDir;
  }

  let pathScope: readonly string[] | undefined;
  if (obj.pathScope !== undefined) {
    if (
      !Array.isArray(obj.pathScope) ||
      !obj.pathScope.every((item) => typeof item === "string" && item.trim().length > 0)
    ) {
      issues.push({ path: "pathScope", message: "pathScope must be an array of non-empty strings" });
    } else {
      pathScope = (obj.pathScope as string[]).map((s) => s.trim());
    }
  }
  if (typeof obj.goodRef !== "string" || obj.goodRef.trim().length === 0) {
    issues.push({ path: "goodRef", message: "goodRef must be a non-empty string" });
  }
  if (typeof obj.badRef !== "string" || obj.badRef.trim().length === 0) {
    issues.push({ path: "badRef", message: "badRef must be a non-empty string" });
  }

  let terms: CustomBisectTerms | undefined;
  if (obj.terms !== undefined) {
    if (!obj.terms || typeof obj.terms !== "object") {
      issues.push({ path: "terms", message: "terms must be an object with 'old' and 'new' properties" });
    } else {
      const rawTerms = obj.terms as Record<string, unknown>;
      const oldTerm = typeof rawTerms.old === "string" ? rawTerms.old : "";
      const newTerm = typeof rawTerms.new === "string" ? rawTerms.new : "";
      const oldVal = validateBisectTerm(oldTerm);
      if (!oldVal.ok) {
        issues.push({ path: "terms.old", message: oldVal.reason ?? "Invalid old term" });
      }
      const newVal = validateBisectTerm(newTerm);
      if (!newVal.ok) {
        issues.push({ path: "terms.new", message: newVal.reason ?? "Invalid new term" });
      }
      if (oldVal.ok && newVal.ok && oldTerm === newTerm) {
        issues.push({ path: "terms", message: `Old and new terms cannot be identical ("${oldTerm}")` });
      }
      if (oldVal.ok && newVal.ok && oldTerm !== newTerm) {
        terms = { old: oldTerm, new: newTerm };
      }
    }
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
        !oObj.overlayFiles.every((f) => typeof f === "string" && isSafeRelativePath(f))
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
      if (oObj.externalScriptPath !== undefined && (typeof oObj.externalScriptPath !== "string" || !isSafeRelativePath(oObj.externalScriptPath))) {
        issues.push({ path: "oracle.externalScriptPath", message: "externalScriptPath must be a safe relative path inside the repository" });
      }
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
  const sandbox = rawExec.sandbox !== undefined ? validateSandboxPolicy(rawExec.sandbox, issues) : undefined;
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
    interactivePrompt:
      typeof rawExec.interactivePrompt === "boolean"
        ? rawExec.interactivePrompt
        : false,
    ...(rawExec.toolchainWrapper &&
    typeof rawExec.toolchainWrapper === "object" &&
    typeof (rawExec.toolchainWrapper as Record<string, unknown>).command === "string"
      ? {
          toolchainWrapper: {
            command: (rawExec.toolchainWrapper as Record<string, unknown>).command as string,
            ...(Array.isArray((rawExec.toolchainWrapper as Record<string, unknown>).args)
              ? {
                  args: ((rawExec.toolchainWrapper as Record<string, unknown>).args as unknown[]).filter(
                    (x): x is string => typeof x === "string"
                  ),
                }
              : {}),
          },
        }
      : {}),
    ...(rawExec.noisyOracle && typeof rawExec.noisyOracle === "object"
      ? {
          noisyOracle: {
            enabled: Boolean((rawExec.noisyOracle as Record<string, unknown>).enabled),
            maxSamplesPerRevision:
              typeof (rawExec.noisyOracle as Record<string, unknown>).maxSamplesPerRevision === "number"
                ? ((rawExec.noisyOracle as Record<string, unknown>).maxSamplesPerRevision as number)
                : 5,
            confidenceThreshold:
              typeof (rawExec.noisyOracle as Record<string, unknown>).confidenceThreshold === "number"
                ? ((rawExec.noisyOracle as Record<string, unknown>).confidenceThreshold as number)
                : 0.9,
            flakeRate:
              typeof (rawExec.noisyOracle as Record<string, unknown>).flakeRate === "number"
                ? ((rawExec.noisyOracle as Record<string, unknown>).flakeRate as number)
                : 0.1,
          },
        }
      : {}),
    ...(sandbox ? { sandbox } : {}),
  };

  if (sandbox && execution.interactivePrompt) {
    issues.push({ path: "execution.interactivePrompt", message: "interactivePrompt is not supported inside a headless container sandbox" });
  }
  if (sandbox && execution.envOverrides && Object.keys(execution.envOverrides).length > 0) {
    issues.push({ path: "execution.envOverrides", message: "envOverrides are not allowed in sandbox mode; use non-secret allowlisted variables" });
  }
  if (sandbox && execution.allowlistedEnvVars.some((name) => SANDBOX_SECRET_ENV_PATTERN.test(name))) {
    issues.push({ path: "execution.allowlistedEnvVars", message: "sandbox allowlistedEnvVars cannot include likely secret names" });
  }

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
  if (execution.noisyOracle) {
    if (
      execution.noisyOracle.maxSamplesPerRevision !== undefined &&
      execution.noisyOracle.maxSamplesPerRevision < 1
    ) {
      issues.push({ path: "execution.noisyOracle.maxSamplesPerRevision", message: "Must be >= 1" });
    }
    if (
      execution.noisyOracle.confidenceThreshold !== undefined &&
      (execution.noisyOracle.confidenceThreshold <= 0.5 || execution.noisyOracle.confidenceThreshold >= 1.0)
    ) {
      issues.push({
        path: "execution.noisyOracle.confidenceThreshold",
        message: "Must be between 0.5 and 1.0",
      });
    }
    if (
      execution.noisyOracle.flakeRate !== undefined &&
      (execution.noisyOracle.flakeRate <= 0.0 || execution.noisyOracle.flakeRate >= 0.5)
    ) {
      issues.push({ path: "execution.noisyOracle.flakeRate", message: "Must be between 0.0 and 0.5" });
    }
  }

  let benchmark: BenchmarkSpec | undefined;
  if (obj.profile === "performance" || obj.benchmark !== undefined) {
    if (!obj.benchmark || typeof obj.benchmark !== "object") {
      issues.push({ path: "benchmark", message: 'benchmark configuration is required when profile is "performance"' });
    } else {
      const bObj = obj.benchmark as Record<string, unknown>;
      const metric = typeof bObj.metric === "string" ? bObj.metric.trim() : "";
      if (metric.length === 0) {
        issues.push({ path: "benchmark.metric", message: "metric must be a non-empty string" });
      }
      const unit = typeof bObj.unit === "string" && bObj.unit.trim().length > 0 ? bObj.unit.trim() : undefined;

      let threshold: number | undefined;
      if (bObj.threshold !== undefined) {
        if (typeof bObj.threshold !== "number" || !Number.isFinite(bObj.threshold)) {
          issues.push({ path: "benchmark.threshold", message: "threshold must be a finite number" });
        } else {
          threshold = bObj.threshold;
        }
      }

      let relativeRegression: number | undefined;
      if (bObj.relativeRegression !== undefined) {
        if (typeof bObj.relativeRegression !== "number" || !Number.isFinite(bObj.relativeRegression) || bObj.relativeRegression < 0) {
          issues.push({ path: "benchmark.relativeRegression", message: "relativeRegression must be a non-negative number" });
        } else {
          relativeRegression = bObj.relativeRegression > 1.0 ? bObj.relativeRegression / 100 : bObj.relativeRegression;
        }
      }

      const direction: BenchmarkDirection =
        bObj.direction === "lower_is_worse" ? "lower_is_worse" : "higher_is_worse";
      if (bObj.direction !== undefined && bObj.direction !== "higher_is_worse" && bObj.direction !== "lower_is_worse") {
        issues.push({ path: "benchmark.direction", message: 'direction must be "higher_is_worse" or "lower_is_worse"' });
      }

      const warmup = typeof bObj.warmup === "number" && Number.isInteger(bObj.warmup) && bObj.warmup >= 0 ? bObj.warmup : 1;
      if (bObj.warmup !== undefined && (typeof bObj.warmup !== "number" || !Number.isInteger(bObj.warmup) || bObj.warmup < 0)) {
        issues.push({ path: "benchmark.warmup", message: "warmup must be an integer >= 0" });
      }

      const minSamples = typeof bObj.minSamples === "number" && Number.isInteger(bObj.minSamples) && bObj.minSamples >= 1 ? bObj.minSamples : 3;
      if (bObj.minSamples !== undefined && (typeof bObj.minSamples !== "number" || !Number.isInteger(bObj.minSamples) || bObj.minSamples < 1)) {
        issues.push({ path: "benchmark.minSamples", message: "minSamples must be an integer >= 1" });
      }

      const maxSamples = typeof bObj.maxSamples === "number" && Number.isInteger(bObj.maxSamples) && bObj.maxSamples >= minSamples ? bObj.maxSamples : Math.max(10, minSamples);
      if (bObj.maxSamples !== undefined && (typeof bObj.maxSamples !== "number" || !Number.isInteger(bObj.maxSamples) || bObj.maxSamples < minSamples)) {
        issues.push({ path: "benchmark.maxSamples", message: `maxSamples must be an integer >= minSamples (${minSamples})` });
      }

      const alpha = typeof bObj.alpha === "number" && Number.isFinite(bObj.alpha) && bObj.alpha > 0 && bObj.alpha <= 0.5 ? bObj.alpha : 0.05;
      if (bObj.alpha !== undefined && (typeof bObj.alpha !== "number" || !Number.isFinite(bObj.alpha) || bObj.alpha <= 0 || bObj.alpha > 0.5)) {
        issues.push({ path: "benchmark.alpha", message: "alpha must be a number between 0 and 0.5" });
      }

      if (metric.length > 0) {
        benchmark = {
          metric,
          ...(unit ? { unit } : {}),
          ...(threshold !== undefined ? { threshold } : {}),
          ...(relativeRegression !== undefined ? { relativeRegression } : {}),
          direction,
          warmup,
          minSamples,
          maxSamples,
          alpha,
        };
      }
    }
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
      ...(pathScope ? { pathScope } : {}),
      goodRef: obj.goodRef as string,
      badRef: obj.badRef as string,
      ...(terms ? { terms } : {}),
      ...(prepare ? { prepare } : {}),
      ...(build ? { build } : {}),
      oracle,
      execution,
      ...(typeof obj.sessionRootDir === "string" ? { sessionRootDir: obj.sessionRootDir } : {}),
      ...(benchmark ? { benchmark } : {}),
    },
  };
}
