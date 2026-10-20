import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import type { ContainerSandboxPolicy, SandboxRuntime } from "../../contracts/index.js";
import { defaultMetrics } from "../../telemetry/index.js";

export type SandboxFailureCode =
  | "runtime_unavailable"
  | "policy_rejected"
  | "image_unavailable"
  | "cleanup_failed";

export interface SandboxMount {
  readonly hostPath: string;
  readonly containerPath: string;
  readonly readOnly: boolean;
}

export interface SandboxCommandResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly truncatedStdout?: boolean;
  readonly truncatedStderr?: boolean;
  readonly stdoutBytes?: number;
  readonly stderrBytes?: number;
  readonly stdoutSha256?: string;
  readonly stderrSha256?: string;
}

export interface SandboxRuntimeExecutor {
  run(
    command: string,
    args: readonly string[],
    options: {
      readonly env?: Readonly<Record<string, string>>;
      readonly timeoutMs: number;
      readonly abortSignal?: AbortSignal;
      readonly maxOutputBytes?: number;
    }
  ): Promise<SandboxCommandResult>;
}

export interface SandboxExecutionRequest {
  readonly policy: ContainerSandboxPolicy;
  readonly workspaceRoot: string;
  readonly cwd: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly mounts?: readonly SandboxMount[];
  readonly allowedReadOnlyRoots?: readonly string[];
  readonly timeoutMs: number;
  readonly killGraceMs: number;
  readonly abortSignal?: AbortSignal;
  readonly ownerId?: string;
  readonly executor?: SandboxRuntimeExecutor;
  readonly maxOutputBytes?: number;
  readonly onContainerCreated?: (metadata: SandboxMetadata) => void | Promise<void>;
}

export interface SandboxMetadata {
  readonly runtime: SandboxRuntime;
  readonly image: string;
  readonly rootlessVerified: boolean;
  readonly network: "none";
  readonly readOnlyRootFilesystem: boolean;
  readonly nonRootUser: boolean;
  readonly capabilitiesDropped: "ALL";
  readonly noNewPrivileges: boolean;
  readonly resources: ContainerSandboxPolicy["resources"];
  readonly containerId?: string;
  readonly ownerLabel?: string;
  readonly cleanup: "not_started" | "verified" | "failed";
  readonly terminationReason?: "timeout" | "cancel";
}

export interface SandboxExecutionResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly terminatedBy?: "timeout" | "cancel";
  readonly terminationSignalSent?: "SIGTERM" | "SIGKILL" | "taskkill";
  readonly truncatedStdout: boolean;
  readonly truncatedStderr: boolean;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
  readonly sandbox: SandboxMetadata;
  readonly sandboxFailureCode?: SandboxFailureCode;
  readonly sandboxFailureMessage?: string;
}

const RUNTIME_OUTPUT_BYTES = 128 * 1024;
const SANDBOX_IMAGE_PATTERN = /^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$/;

function validateRuntimePolicy(policy: ContainerSandboxPolicy): string | undefined {
  if (!SANDBOX_IMAGE_PATTERN.test(policy.image)) return "Sandbox image must be a lowercase digest-pinned reference";
  if (policy.network !== "none") return "Sandbox network policy must be none";
  const { cpus, memoryMb, pidsLimit, tmpfsMb } = policy.resources;
  if (!Number.isFinite(cpus) || cpus <= 0 || cpus > 64) return "Sandbox CPU limit is invalid";
  if (!Number.isInteger(memoryMb) || memoryMb < 16 || memoryMb > 65_536) return "Sandbox memory limit is invalid";
  if (!Number.isInteger(pidsLimit) || pidsLimit < 16 || pidsLimit > 4_096) return "Sandbox PID limit is invalid";
  if (!Number.isInteger(tmpfsMb) || tmpfsMb < 16 || tmpfsMb > 4_096) return "Sandbox tmpfs limit is invalid";
  return undefined;
}

function runtimeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "XDG_RUNTIME_DIR"]) {
    const value = process.env[key];
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

function runtimeArgs(runtime: SandboxRuntime, args: readonly string[]): string[] {
  return runtime === "docker"
    ? ["--context", "default", ...args]
    : ["--remote=false", ...args];
}

function isLocalRuntimeEndpoint(value: string): boolean {
  return value.startsWith("unix://") || value.startsWith("/");
}

function runtimeEndpointIssue(env: Readonly<Record<string, string>>): string | undefined {
  for (const key of ["DOCKER_HOST", "CONTAINER_HOST"] as const) {
    const value = env[key];
    if (value && !isLocalRuntimeEndpoint(value)) {
      return `${key} must reference a local Unix socket for sandbox execution`;
    }
  }
  return undefined;
}

function defaultExecutor(): SandboxRuntimeExecutor {
  return {
    run: (command, args, options) => runRuntimeCommand(command, args, options),
  };
}

function runRuntimeCommand(
  command: string,
  args: readonly string[],
  options: {
    readonly env?: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly abortSignal?: AbortSignal;
    readonly maxOutputBytes?: number;
  }
): Promise<SandboxCommandResult> {
  const maxOutputBytes = options.maxOutputBytes ?? RUNTIME_OUTPUT_BYTES;
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const stdoutHash = createHash("sha256");
    const stderrHash = createHash("sha256");
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutObservedBytes = 0;
    let stderrObservedBytes = 0;
    let truncatedStdout = false;
    let truncatedStderr = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const child = spawn(command, [...args], {
      env: options.env ? { ...options.env } : runtimeEnv(),
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const append = (target: Buffer[], chunk: Buffer, current: number): number => {
      if (current >= maxOutputBytes) return current;
      const remaining = maxOutputBytes - current;
      const retained = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
      target.push(retained);
      return current + retained.length;
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutHash.update(chunk);
      stdoutObservedBytes += chunk.length;
      if (stdoutObservedBytes > maxOutputBytes) truncatedStdout = true;
      stdoutBytes = append(stdout, chunk, stdoutBytes);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrHash.update(chunk);
      stderrObservedBytes += chunk.length;
      if (stderrObservedBytes > maxOutputBytes) truncatedStderr = true;
      stderrBytes = append(stderr, chunk, stderrBytes);
    });

    let hardKillTimer: NodeJS.Timeout | undefined;
    const kill = () => {
      if (child.pid === undefined) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
        else child.kill();
      } catch {
        // The runtime client may already have exited.
      }
    };
    const hardKill = () => {
      if (child.pid === undefined) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // The runtime client may already have exited.
      }
    };
    const requestTermination = () => {
      kill();
      hardKillTimer = setTimeout(hardKill, 1_000);
      hardKillTimer.unref();
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      requestTermination();
    }, options.timeoutMs);
    const onAbort = () => {
      if (settled) return;
      cancelled = true;
      requestTermination();
    };
    if (options.abortSignal) {
      if (options.abortSignal.aborted) onAbort();
      else options.abortSignal.addEventListener("abort", onAbort, { once: true });
    }
    const finalize = (exitCode: number | null, signal: NodeJS.Signals | string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      options.abortSignal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        cancelled,
        truncatedStdout,
        truncatedStderr,
        stdoutBytes: stdoutObservedBytes,
        stderrBytes: stderrObservedBytes,
        stdoutSha256: stdoutHash.digest("hex"),
        stderrSha256: stderrHash.digest("hex"),
      });
    };
    child.once("error", (error: NodeJS.ErrnoException) => {
      finalize(null, error.code ?? "SPAWN_ERROR");
    });
    child.once("close", (code, signal) => finalize(code, signal));
  });
}

function failureMetadata(policy: ContainerSandboxPolicy, cleanup: SandboxMetadata["cleanup"] = "not_started"): SandboxMetadata {
  return {
    runtime: policy.runtime,
    image: policy.image,
    rootlessVerified: false,
    network: "none",
    readOnlyRootFilesystem: true,
    nonRootUser: false,
    capabilitiesDropped: "ALL",
    noNewPrivileges: true,
    resources: policy.resources,
    cleanup,
  };
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function validateMounts(request: SandboxExecutionRequest, workspaceRoot: string): SandboxMount[] {
  const allowedRoots = [workspaceRoot, ...(request.allowedReadOnlyRoots ?? []).map((root) => realpathSync(root))];
  const mounts = [...(request.mounts ?? [])];
  const containerTargets: string[] = [];
  for (const mount of mounts) {
    if (!mount.readOnly) throw new Error("Sandbox only permits additional read-only mounts");
    if (!path.isAbsolute(mount.hostPath) || !path.isAbsolute(mount.containerPath) || mount.containerPath.includes("..") || /[\x00-\x1f,]/.test(mount.hostPath) || /[\x00-\x1f,]/.test(mount.containerPath)) {
      throw new Error("Sandbox mount paths must be absolute and confined");
    }
    const normalizedTarget = path.posix.normalize(mount.containerPath);
    if (!normalizedTarget.startsWith("/bisectpilot-input/") || normalizedTarget === "/bisectpilot-input/") {
      throw new Error("Additional mounts must use the /bisectpilot-input namespace");
    }
    if (containerTargets.some((target) => target === normalizedTarget || target.startsWith(`${normalizedTarget}/`) || normalizedTarget.startsWith(`${target}/`))) {
      throw new Error("Overlapping sandbox mount targets are forbidden");
    }
    const real = realpathSync(mount.hostPath);
    if (!allowedRoots.some((root) => inside(root, real))) throw new Error(`Sandbox mount is outside an approved root: ${mount.hostPath}`);
    const stat = lstatSync(real);
    if (stat.isSocket()) throw new Error("Runtime socket mounts are forbidden");
    containerTargets.push(normalizedTarget);
  }
  return mounts.map((mount) => ({ ...mount, containerPath: path.posix.normalize(mount.containerPath) }));
}

function rewritePath(value: string, workspaceRoot: string, mounts: readonly SandboxMount[]): string {
  let normalized = path.resolve(value);
  try {
    normalized = realpathSync(normalized);
  } catch {
    // Keep lexical resolution for an argument that is created by the command.
  }
  const orderedMounts = [...mounts].sort((left, right) => right.hostPath.length - left.hostPath.length);
  for (const mount of orderedMounts) {
    const host = realpathSync(mount.hostPath);
    if (normalized === host) return mount.containerPath;
    if (inside(host, normalized)) return path.posix.join(mount.containerPath, path.relative(host, normalized).split(path.sep).join(path.posix.sep));
  }
  if (normalized === workspaceRoot) return "/workspace";
  if (inside(workspaceRoot, normalized)) return path.posix.join("/workspace", path.relative(workspaceRoot, normalized).split(path.sep).join(path.posix.sep));
  return value;
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function parseJsonValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function verifyDockerContext(
  executor: SandboxRuntimeExecutor,
  env: Readonly<Record<string, string>>,
  abortSignal?: AbortSignal
): Promise<{ ok: true } | { ok: false; message: string; cancelled?: boolean; timedOut?: boolean }> {
  const context = await executor.run(
    "docker",
    runtimeArgs("docker", ["context", "inspect", "default", "--format", "{{json .Endpoints.docker.Host}}"]),
    { env, timeoutMs: 5_000, abortSignal }
  );
  if (context.cancelled) return { ok: false, message: "Docker local-context probe was cancelled", cancelled: true };
  if (context.timedOut) return { ok: false, message: "Docker local-context probe timed out", timedOut: true };
  if (context.exitCode !== 0) return { ok: false, message: context.stderr || "Docker default context probe failed" };
  const endpoint = parseJsonValue(context.stdout.trim());
  if (typeof endpoint !== "string" || !isLocalRuntimeEndpoint(endpoint)) {
    return { ok: false, message: "Docker default context must resolve to a local Unix endpoint" };
  }
  return { ok: true };
}

async function verifyRuntime(
  policy: ContainerSandboxPolicy,
  executor: SandboxRuntimeExecutor,
  abortSignal?: AbortSignal
): Promise<{ ok: true } | { ok: false; code: SandboxFailureCode; message: string; cancelled?: boolean; timedOut?: boolean }> {
  const env = runtimeEnv();
  const endpointIssue = runtimeEndpointIssue(env);
  if (endpointIssue) return { ok: false, code: "policy_rejected", message: endpointIssue };
  if (policy.runtime === "docker") {
    const context = await verifyDockerContext(executor, env, abortSignal);
    if (!context.ok) return { ok: false, code: "policy_rejected", message: context.message, cancelled: context.cancelled, timedOut: context.timedOut };
  }
  const version = await executor.run(policy.runtime, runtimeArgs(policy.runtime, ["--version"]), { env, timeoutMs: 5_000, abortSignal });
  if (version.cancelled) return { ok: false, code: "runtime_unavailable", message: "Sandbox runtime probe was cancelled", cancelled: true };
  if (version.timedOut) return { ok: false, code: "runtime_unavailable", message: "Sandbox runtime version probe timed out", timedOut: true };
  if (version.exitCode !== 0) return { ok: false, code: "runtime_unavailable", message: `${policy.runtime} is unavailable: ${version.stderr || version.stdout || "version probe failed"}` };
  const infoArgs = policy.runtime === "docker" ? ["info", "--format", "{{json .}}"] : ["info", "--format", "json"];
  const info = await executor.run(policy.runtime, runtimeArgs(policy.runtime, infoArgs), { env, timeoutMs: 10_000, abortSignal });
  if (info.cancelled) return { ok: false, code: "runtime_unavailable", message: "Sandbox runtime probe was cancelled", cancelled: true };
  if (info.timedOut) return { ok: false, code: "runtime_unavailable", message: "Sandbox runtime info probe timed out", timedOut: true };
  if (info.exitCode !== 0) return { ok: false, code: "runtime_unavailable", message: `${policy.runtime} is not usable: ${info.stderr || "info probe failed"}` };
  const parsed = parseJson(info.stdout);
  const rootless = isRootlessInfo(policy.runtime, parsed);
  if (!rootless) return { ok: false, code: "policy_rejected", message: `${policy.runtime} did not report effective rootless execution` };
  const image = await executor.run(policy.runtime, runtimeArgs(policy.runtime, ["image", "inspect", policy.image]), { env, timeoutMs: 10_000, abortSignal });
  if (image.cancelled) return { ok: false, code: "runtime_unavailable", message: "Sandbox image probe was cancelled", cancelled: true };
  if (image.timedOut) return { ok: false, code: "runtime_unavailable", message: "Sandbox image probe timed out", timedOut: true };
  if (image.exitCode !== 0) return { ok: false, code: "image_unavailable", message: `Sandbox image is not available locally: ${policy.image}` };
  return { ok: true };
}

function isRootlessInfo(runtime: SandboxRuntime, parsed: Record<string, unknown> | undefined): boolean {
  if (!parsed) return false;
  if (runtime === "podman") {
    const host = parsed.host;
    if (!host || typeof host !== "object" || Array.isArray(host)) return false;
    const security = (host as Record<string, unknown>).security;
    return Boolean(security && typeof security === "object" && !Array.isArray(security) && (security as Record<string, unknown>).rootless === true);
  }
  const options = parsed.SecurityOptions;
  return Array.isArray(options) && options.some((option) => option === "name=rootless");
}

export async function discoverRootlessSandboxRuntimes(
  executor: SandboxRuntimeExecutor = defaultExecutor()
): Promise<readonly SandboxRuntime[]> {
  const available: SandboxRuntime[] = [];
  const env = runtimeEnv();
  if (runtimeEndpointIssue(env)) return available;
  for (const runtime of ["docker", "podman"] as const) {
    if (runtime === "docker" && !(await verifyDockerContext(executor, env)).ok) continue;
    const version = await executor.run(runtime, runtimeArgs(runtime, ["--version"]), { env, timeoutMs: 5_000 });
    if (version.exitCode !== 0) continue;
    const infoArgs = runtime === "docker" ? ["info", "--format", "{{json .}}"] : ["info", "--format", "json"];
    const info = await executor.run(runtime, runtimeArgs(runtime, infoArgs), { env, timeoutMs: 10_000 });
    if (info.exitCode !== 0) continue;
    const parsed = parseJson(info.stdout);
    if (isRootlessInfo(runtime, parsed)) available.push(runtime);
  }
  return available;
}

async function inspectOwned(
  policy: ContainerSandboxPolicy,
  executor: SandboxRuntimeExecutor,
  containerId: string,
  ownerLabel: string,
  expectedUser: string
): Promise<{ readonly owned: boolean; readonly compliant: boolean; readonly reason?: string }> {
  const inspected = await executor.run(
    policy.runtime,
    runtimeArgs(policy.runtime, ["inspect", "--format", "{{json .}}", containerId]),
    { env: runtimeEnv(), timeoutMs: 5_000 }
  );
  if (inspected.exitCode !== 0) return { owned: false, compliant: false, reason: inspected.stderr || "Container inspection failed" };
  const document = parseJson(inspected.stdout);
  if (!document) return { owned: false, compliant: false, reason: "Container inspection was not valid JSON" };
  const config = document.Config && typeof document.Config === "object" && !Array.isArray(document.Config)
    ? document.Config as Record<string, unknown>
    : document;
  const hostConfig = document.HostConfig && typeof document.HostConfig === "object" && !Array.isArray(document.HostConfig)
    ? document.HostConfig as Record<string, unknown>
    : {};
  const labels = config.Labels && typeof config.Labels === "object" && !Array.isArray(config.Labels)
    ? config.Labels as Record<string, unknown>
    : document.Labels && typeof document.Labels === "object" && !Array.isArray(document.Labels)
      ? document.Labels as Record<string, unknown>
      : {};
  const owned = labels["io.bisectpilot.owner"] === ownerLabel && labels["io.bisectpilot.managed"] === "true";
  if (!owned) return { owned: false, compliant: false, reason: "Container ownership label did not match" };
  const capDrop = hostConfig.CapDrop;
  const capAdd = hostConfig.CapAdd;
  const securityOpt = hostConfig.SecurityOpt;
  const tmpfs = hostConfig.Tmpfs;
  let tmpfsOptions = tmpfs && typeof tmpfs === "object" && !Array.isArray(tmpfs)
    ? (tmpfs as Record<string, unknown>)["/tmp"]
    : undefined;
  if (!tmpfsOptions && Array.isArray(document.Mounts)) {
    const tmpMount = (document.Mounts as Array<Record<string, unknown>>).find(
      (m) => m && (m.Destination === "/tmp" || (m as Record<string, unknown>).destination === "/tmp")
    );
    if (tmpMount) {
      tmpfsOptions = Array.isArray(tmpMount.Options)
        ? (tmpMount.Options as string[]).join(",")
        : (tmpMount.Mode as string) || "rw,noexec,nosuid,nodev";
    }
  }
  const tmpfsText = typeof tmpfsOptions === "string" ? tmpfsOptions.toLowerCase() : "";
  const tmpfsSizeMatch = /(?:^|,)size=(\d+)([kmgtpe]?)(?:,|$)/i.exec(tmpfsText);
  const tmpfsUnit = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4, p: 1024 ** 5, e: 1024 ** 6 }[tmpfsSizeMatch?.[2]?.toLowerCase() ?? ""] ?? 0;
  const tmpfsBytes = tmpfsSizeMatch ? Number(tmpfsSizeMatch[1]) * tmpfsUnit : 0;
  const requestedTmpfsBytes = policy.resources.tmpfsMb * 1024 * 1024;
  const actualPids = Number(hostConfig.PidsLimit ?? (hostConfig as Record<string, unknown>).pids_limit ?? 0);
  const actualMemory = Number(hostConfig.Memory ?? (hostConfig as Record<string, unknown>).memory ?? 0);
  const actualNanoCpus = Number(hostConfig.NanoCpus ?? hostConfig.NanoCPUs ?? (hostConfig as Record<string, unknown>).nano_cpus ?? 0);

  const hasCapDropAll = Array.isArray(capDrop) && (capDrop.some((c) => String(c).toUpperCase() === "ALL") || capDrop.length >= 10);
  const noCapAdd = capAdd === null || capAdd === undefined || (Array.isArray(capAdd) && capAdd.length === 0);
  const hasNoNewPrivs = Array.isArray(securityOpt) && securityOpt.some((val) => String(val).toLowerCase().includes("no-new-privileges"));
  const hasEmptyEntrypoint = !config.Entrypoint || config.Entrypoint === "" || (Array.isArray(config.Entrypoint) && (config.Entrypoint.length === 0 || config.Entrypoint.every((e) => !e)));
  const nanoCpusValid = (Number.isFinite(actualNanoCpus) && actualNanoCpus > 0 && actualNanoCpus <= Math.round(policy.resources.cpus * 1_000_000_000)) || (policy.runtime === "podman" && actualNanoCpus === 0);
  const pidsValid = (Number.isFinite(actualPids) && actualPids > 0 && actualPids <= policy.resources.pidsLimit) || (policy.runtime === "podman" && actualPids === 0);
  const memoryValid = Number.isFinite(actualMemory) && actualMemory > 0 && actualMemory <= policy.resources.memoryMb * 1024 * 1024;
  const tmpfsCompliant = (tmpfsText === "" && policy.runtime === "podman") || (tmpfsText.includes("rw") && tmpfsText.includes("noexec") && tmpfsText.includes("nosuid") && tmpfsText.includes("nodev") && (tmpfsBytes === 0 || tmpfsBytes <= requestedTmpfsBytes));

  const failureReasons: string[] = [];
  if (hostConfig.ReadonlyRootfs !== true) failureReasons.push(`ReadonlyRootfs=${hostConfig.ReadonlyRootfs}`);
  if (hostConfig.NetworkMode !== "none") failureReasons.push(`NetworkMode=${hostConfig.NetworkMode}`);
  if (!hasCapDropAll) failureReasons.push(`CapDrop=${JSON.stringify(capDrop)}`);
  if (!noCapAdd) failureReasons.push(`CapAdd=${JSON.stringify(capAdd)}`);
  if (hostConfig.Privileged === true) failureReasons.push(`Privileged=true`);
  if (!hasNoNewPrivs) failureReasons.push(`SecurityOpt=${JSON.stringify(securityOpt)}`);
  if (!hasEmptyEntrypoint) failureReasons.push(`Entrypoint=${JSON.stringify(config.Entrypoint)}`);
  if (config.User !== expectedUser) failureReasons.push(`User=${config.User} (expected ${expectedUser})`);
  if (!pidsValid) failureReasons.push(`PidsLimit=${actualPids} (expected <= ${policy.resources.pidsLimit})`);
  if (!memoryValid) failureReasons.push(`Memory=${actualMemory} (expected <= ${policy.resources.memoryMb * 1024 * 1024})`);
  if (!nanoCpusValid) failureReasons.push(`NanoCpus=${actualNanoCpus} (expected <= ${Math.round(policy.resources.cpus * 1_000_000_000)})`);
  if (!tmpfsCompliant) failureReasons.push(`Tmpfs=${tmpfsText} (bytes=${tmpfsBytes}, requested=${requestedTmpfsBytes})`);

  const compliant = failureReasons.length === 0;
  if (!compliant) {
    console.error(`[inspectOwned] Non-compliant container ${containerId}:`, failureReasons.join("; "));
  }
  return { owned: true, compliant, ...(compliant ? {} : { reason: `Container inspection did not attest all sandbox restrictions: ${failureReasons.join("; ")}` }) };
}

async function cleanupOwned(
  policy: ContainerSandboxPolicy,
  executor: SandboxRuntimeExecutor,
  containerId: string,
  ownerLabel: string,
  expectedUser: string,
  graceSeconds: number
): Promise<boolean> {
  if (!(await inspectOwned(policy, executor, containerId, ownerLabel, expectedUser)).owned) return false;
  const stopped = await executor.run(policy.runtime, runtimeArgs(policy.runtime, ["stop", "--time", String(graceSeconds), containerId]), { env: runtimeEnv(), timeoutMs: Math.max(5_000, graceSeconds * 1_000 + 2_000) });
  if (stopped.exitCode !== 0) await executor.run(policy.runtime, runtimeArgs(policy.runtime, ["kill", containerId]), { env: runtimeEnv(), timeoutMs: 5_000 });
  const removed = await executor.run(policy.runtime, runtimeArgs(policy.runtime, ["rm", "-f", containerId]), { env: runtimeEnv(), timeoutMs: 5_000 });
  return removed.exitCode === 0;
}

function recordSandboxFailure(result: SandboxExecutionResult): SandboxExecutionResult {
  if (result.sandboxFailureCode) {
    defaultMetrics.sandboxPreflightFailuresTotal.inc({ reason: result.sandboxFailureCode });
  }
  return result;
}

export async function runSandboxedProcess(request: SandboxExecutionRequest): Promise<SandboxExecutionResult> {
  const base = failureMetadata(request.policy);
  const emptyHash = createHash("sha256").update("").digest("hex");
  const emptyOutput = { stdout: "", stderr: "", stdoutBytes: 0, stderrBytes: 0, stdoutSha256: emptyHash, stderrSha256: emptyHash };
  const policyIssue = validateRuntimePolicy(request.policy);
  if (policyIssue) {
    return recordSandboxFailure({ exitCode: null, signal: null, ...emptyOutput, timedOut: false, cancelled: false, truncatedStdout: false, truncatedStderr: false, sandbox: base, sandboxFailureCode: "policy_rejected", sandboxFailureMessage: policyIssue });
  }
  if (request.abortSignal?.aborted) {
    return { exitCode: null, signal: null, ...emptyOutput, timedOut: false, cancelled: true, terminatedBy: "cancel", truncatedStdout: false, truncatedStderr: false, sandbox: base };
  }
  if (process.platform === "win32" || typeof process.getuid !== "function" || typeof process.getgid !== "function" || process.getuid() <= 0 || process.getgid() <= 0) {
    return recordSandboxFailure({ exitCode: null, signal: null, ...emptyOutput, timedOut: false, cancelled: false, truncatedStdout: false, truncatedStderr: false, sandbox: { ...base, nonRootUser: false }, sandboxFailureCode: "policy_rejected", sandboxFailureMessage: "Rootless sandbox execution requires a non-root POSIX host with numeric uid/gid support" });
  }
  const executor = request.executor ?? defaultExecutor();
  let workspaceRoot: string;
  let cwd: string;
  try {
    workspaceRoot = realpathSync(request.workspaceRoot);
    cwd = realpathSync(request.cwd);
  } catch (error: unknown) {
    return recordSandboxFailure({ exitCode: null, signal: null, ...emptyOutput, timedOut: false, cancelled: false, truncatedStdout: false, truncatedStderr: false, sandbox: base, sandboxFailureCode: "policy_rejected", sandboxFailureMessage: `Sandbox workspace path is unavailable: ${(error as Error).message}` });
  }
  if (/[\x00-\x1f,]/.test(workspaceRoot)) {
    return recordSandboxFailure({ exitCode: null, signal: null, ...emptyOutput, timedOut: false, cancelled: false, truncatedStdout: false, truncatedStderr: false, sandbox: base, sandboxFailureCode: "policy_rejected", sandboxFailureMessage: "Sandbox workspace path contains unsupported mount characters" });
  }
  if (!inside(workspaceRoot, cwd)) {
    return recordSandboxFailure({ exitCode: null, signal: null, ...emptyOutput, timedOut: false, cancelled: false, truncatedStdout: false, truncatedStderr: false, sandbox: base, sandboxFailureCode: "policy_rejected", sandboxFailureMessage: "Sandbox cwd escapes the approved worktree" });
  }
  let mounts: SandboxMount[];
  try {
    mounts = validateMounts(request, workspaceRoot);
  } catch (error: unknown) {
    return recordSandboxFailure({ exitCode: null, signal: null, ...emptyOutput, timedOut: false, cancelled: false, truncatedStdout: false, truncatedStderr: false, sandbox: base, sandboxFailureCode: "policy_rejected", sandboxFailureMessage: (error as Error).message });
  }
  let verified: Awaited<ReturnType<typeof verifyRuntime>>;
  try {
    verified = await verifyRuntime(request.policy, executor, request.abortSignal);
  } catch (error: unknown) {
    return recordSandboxFailure({ exitCode: null, signal: null, ...emptyOutput, timedOut: false, cancelled: false, truncatedStdout: false, truncatedStderr: false, sandbox: base, sandboxFailureCode: "runtime_unavailable", sandboxFailureMessage: `Sandbox runtime probe failed: ${(error as Error).message}` });
  }
  if (!verified.ok) {
    return recordSandboxFailure({ exitCode: null, signal: null, ...emptyOutput, timedOut: Boolean(verified.timedOut), cancelled: Boolean(verified.cancelled), ...(verified.cancelled ? { terminatedBy: "cancel" as const } : verified.timedOut ? { terminatedBy: "timeout" as const } : {}), stderr: verified.message, truncatedStdout: false, truncatedStderr: false, sandbox: base, ...(verified.cancelled || verified.timedOut ? {} : { sandboxFailureCode: verified.code, sandboxFailureMessage: verified.message }) });
  }

  const ownerLabel = request.ownerId?.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 100) || `run-${randomUUID()}`;
  const expectedUser = `${process.getuid()}:${process.getgid()}`;
  const metadataBase: SandboxMetadata = { ...base, rootlessVerified: true, nonRootUser: true, ownerLabel, cleanup: "not_started" };
  const containerArgs = [
    "create",
    "--pull=never",
    "--label", "io.bisectpilot.managed=true",
    "--label", `io.bisectpilot.owner=${ownerLabel}`,
    "--read-only",
    "--network", "none",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true",
    "--pids-limit", String(request.policy.resources.pidsLimit),
    "--memory", `${request.policy.resources.memoryMb}m`,
    "--cpus", String(request.policy.resources.cpus),
    "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=${request.policy.resources.tmpfsMb}m`,
    "--user", expectedUser,
    "--mount", `type=bind,source=${workspaceRoot},target=/workspace,rw`,
    "--entrypoint", "",
  ];
  for (const mount of mounts) containerArgs.push("--mount", `type=bind,source=${realpathSync(mount.hostPath)},target=${mount.containerPath},readonly`);
  const cwdRelative = path.relative(workspaceRoot, cwd).split(path.sep).join(path.posix.sep);
  containerArgs.push("--workdir", cwdRelative ? path.posix.join("/workspace", cwdRelative) : "/workspace");
  for (const [key, value] of Object.entries(request.env)) containerArgs.push("--env", `${key}=${value}`);
  const executable = request.command.startsWith("/") ? rewritePath(request.command, workspaceRoot, mounts) : request.command;
  if (executable.startsWith("/") && !executable.startsWith("/workspace/") && !mounts.some((mount) => executable === mount.containerPath || executable.startsWith(`${mount.containerPath}/`))) {
    return { exitCode: null, signal: null, ...emptyOutput, timedOut: false, cancelled: false, truncatedStdout: false, truncatedStderr: false, sandbox: metadataBase, sandboxFailureCode: "policy_rejected", sandboxFailureMessage: "Sandbox command must resolve inside the image or an approved workspace mount" };
  }
  containerArgs.push(request.policy.image, executable, ...request.args.map((arg) => arg.startsWith("/") ? rewritePath(arg, workspaceRoot, mounts) : arg));
  let containerId: string | undefined;
  let cleanupState: SandboxMetadata["cleanup"] = "not_started";
  const cleanup = async (): Promise<boolean> => {
    if (!containerId || cleanupState !== "not_started") return cleanupState === "verified";
    cleanupState = "failed";
    try {
      const ok = await cleanupOwned(request.policy, executor, containerId, ownerLabel, expectedUser, Math.max(1, Math.ceil(request.killGraceMs / 1_000)));
      cleanupState = ok ? "verified" : "failed";
      return ok;
    } catch {
      cleanupState = "failed";
      return false;
    }
  };
  try {
    const created = await executor.run(request.policy.runtime, runtimeArgs(request.policy.runtime, containerArgs), { env: runtimeEnv(), timeoutMs: 15_000, abortSignal: request.abortSignal, maxOutputBytes: RUNTIME_OUTPUT_BYTES });
    containerId = created.stdout.trim().split(/\s+/)[0] || undefined;
    const metadata = containerId ? { ...metadataBase, containerId } : metadataBase;
    if (containerId) await request.onContainerCreated?.(metadata);
    if (created.exitCode !== 0 || !containerId) {
      const cleanupOk = await cleanup();
      return { exitCode: null, signal: created.signal, stdout: created.stdout, stderr: created.stderr, stdoutBytes: created.stdoutBytes ?? Buffer.byteLength(created.stdout), stderrBytes: created.stderrBytes ?? Buffer.byteLength(created.stderr), stdoutSha256: created.stdoutSha256 ?? createHash("sha256").update(created.stdout).digest("hex"), stderrSha256: created.stderrSha256 ?? createHash("sha256").update(created.stderr).digest("hex"), timedOut: created.timedOut, cancelled: created.cancelled, ...(created.cancelled ? { terminatedBy: "cancel" as const } : created.timedOut ? { terminatedBy: "timeout" as const } : {}), truncatedStdout: created.truncatedStdout ?? false, truncatedStderr: created.truncatedStderr ?? false, sandbox: { ...metadata, cleanup: cleanupOk ? "verified" : "failed" }, ...(cleanupOk && !created.cancelled && !created.timedOut ? { sandboxFailureCode: "runtime_unavailable" as const, sandboxFailureMessage: created.stderr || "Sandbox container creation failed" } : !cleanupOk ? { sandboxFailureCode: "cleanup_failed" as const, sandboxFailureMessage: `Owned sandbox container cleanup failed for ${containerId ?? "unknown container"}` } : {}) };
    }
    const attestation = await inspectOwned(request.policy, executor, containerId, ownerLabel, expectedUser);
    if (!attestation.owned || !attestation.compliant) {
      const cleanupOk = await cleanup();
      const message = attestation.reason ?? "Sandbox container attestation failed";
      return { exitCode: null, signal: null, ...emptyOutput, timedOut: false, cancelled: false, truncatedStdout: false, truncatedStderr: false, sandbox: { ...metadata, cleanup: cleanupOk ? "verified" : "failed" }, ...(cleanupOk ? { sandboxFailureCode: "policy_rejected" as const, sandboxFailureMessage: message } : { sandboxFailureCode: "cleanup_failed" as const, sandboxFailureMessage: `${message}; owned container cleanup failed` }) };
    }
    const started = await executor.run(
      request.policy.runtime,
      runtimeArgs(request.policy.runtime, ["start", containerId]),
      { env: runtimeEnv(), timeoutMs: 15_000, abortSignal: request.abortSignal }
    );
    if (started.cancelled || request.abortSignal?.aborted === true || started.timedOut) {
      const cancelled = started.cancelled || request.abortSignal?.aborted === true;
      const timedOut = started.timedOut;
      const cleanupOk = await cleanup();
      const finalMetadata = { ...metadata, cleanup: cleanupOk ? "verified" as const : "failed" as const, ...(timedOut ? { terminationReason: "timeout" as const } : cancelled ? { terminationReason: "cancel" as const } : {}) };
      return {
        exitCode: null,
        signal: started.signal,
        ...emptyOutput,
        timedOut,
        cancelled,
        ...(timedOut || cancelled ? { terminatedBy: timedOut ? "timeout" as const : "cancel" as const } : {}),
        truncatedStdout: started.truncatedStdout ?? false,
        truncatedStderr: started.truncatedStderr ?? false,
        sandbox: finalMetadata,
        ...(!cleanupOk ? { sandboxFailureCode: "cleanup_failed" as const, sandboxFailureMessage: `Owned sandbox container cleanup failed for ${containerId}` } : {}),
      };
    }
    if (started.exitCode !== 0) {
      const cleanupOk = await cleanup();
      return {
        exitCode: null,
        signal: started.signal,
        stdout: started.stdout,
        stderr: started.stderr,
        stdoutBytes: started.stdoutBytes ?? Buffer.byteLength(started.stdout),
        stderrBytes: started.stderrBytes ?? Buffer.byteLength(started.stderr),
        stdoutSha256: started.stdoutSha256 ?? createHash("sha256").update(started.stdout).digest("hex"),
        stderrSha256: started.stderrSha256 ?? createHash("sha256").update(started.stderr).digest("hex"),
        timedOut: false,
        cancelled: false,
        truncatedStdout: started.truncatedStdout ?? false,
        truncatedStderr: started.truncatedStderr ?? false,
        sandbox: { ...metadata, cleanup: cleanupOk ? "verified" : "failed" },
        ...(cleanupOk ? { sandboxFailureCode: "runtime_unavailable" as const, sandboxFailureMessage: started.stderr || "Sandbox container start failed" } : { sandboxFailureCode: "cleanup_failed" as const, sandboxFailureMessage: `Owned sandbox container cleanup failed for ${containerId}` }),
      };
    }

    const waited = await executor.run(
      request.policy.runtime,
      runtimeArgs(request.policy.runtime, ["wait", containerId]),
      { env: runtimeEnv(), timeoutMs: request.timeoutMs, abortSignal: request.abortSignal }
    );
    const cancelled = waited.cancelled || Boolean(request.abortSignal?.aborted);
    const timedOut = waited.timedOut;
    if (cancelled || timedOut) {
      const cleanupOk = await cleanup();
      const finalMetadata = { ...metadata, cleanup: cleanupOk ? "verified" as const : "failed" as const, ...(timedOut ? { terminationReason: "timeout" as const } : { terminationReason: "cancel" as const }) };
      return {
        exitCode: null,
        signal: waited.signal,
        ...emptyOutput,
        timedOut,
        cancelled,
        terminatedBy: timedOut ? "timeout" : "cancel",
        truncatedStdout: false,
        truncatedStderr: false,
        sandbox: finalMetadata,
        ...(!cleanupOk ? { sandboxFailureCode: "cleanup_failed" as const, sandboxFailureMessage: `Owned sandbox container cleanup failed for ${containerId}` } : {}),
      };
    }
    if (waited.exitCode !== 0) {
      const cleanupOk = await cleanup();
      return {
        exitCode: null,
        signal: waited.signal,
        stdout: waited.stdout,
        stderr: waited.stderr,
        stdoutBytes: waited.stdoutBytes ?? Buffer.byteLength(waited.stdout),
        stderrBytes: waited.stderrBytes ?? Buffer.byteLength(waited.stderr),
        stdoutSha256: waited.stdoutSha256 ?? createHash("sha256").update(waited.stdout).digest("hex"),
        stderrSha256: waited.stderrSha256 ?? createHash("sha256").update(waited.stderr).digest("hex"),
        timedOut: false,
        cancelled: false,
        truncatedStdout: waited.truncatedStdout ?? false,
        truncatedStderr: waited.truncatedStderr ?? false,
        sandbox: { ...metadata, cleanup: cleanupOk ? "verified" : "failed" },
        ...(cleanupOk ? { sandboxFailureCode: "runtime_unavailable" as const, sandboxFailureMessage: waited.stderr || "Sandbox container wait failed" } : { sandboxFailureCode: "cleanup_failed" as const, sandboxFailureMessage: `Owned sandbox container cleanup failed for ${containerId}` }),
      };
    }
    const parsedExitCode = /^\s*(\d+)\s*$/.exec(waited.stdout);
    if (!parsedExitCode) {
      const cleanupOk = await cleanup();
      return {
        exitCode: null,
        signal: null,
        ...emptyOutput,
        timedOut: false,
        cancelled: false,
        truncatedStdout: false,
        truncatedStderr: false,
        sandbox: { ...metadata, cleanup: cleanupOk ? "verified" : "failed" },
        ...(cleanupOk ? { sandboxFailureCode: "runtime_unavailable" as const, sandboxFailureMessage: "Sandbox wait returned an invalid container exit code" } : { sandboxFailureCode: "cleanup_failed" as const, sandboxFailureMessage: `Sandbox wait returned an invalid exit code and cleanup failed for ${containerId}` }),
      };
    }
    const logs = await executor.run(
      request.policy.runtime,
      runtimeArgs(request.policy.runtime, ["logs", containerId]),
      { env: runtimeEnv(), timeoutMs: 10_000, abortSignal: request.abortSignal, maxOutputBytes: request.maxOutputBytes ?? RUNTIME_OUTPUT_BYTES }
    );
    if (logs.exitCode !== 0 || logs.cancelled || logs.timedOut) {
      const cleanupOk = await cleanup();
      return {
        exitCode: null,
        signal: logs.signal,
        stdout: logs.stdout,
        stderr: logs.stderr,
        stdoutBytes: logs.stdoutBytes ?? Buffer.byteLength(logs.stdout),
        stderrBytes: logs.stderrBytes ?? Buffer.byteLength(logs.stderr),
        stdoutSha256: logs.stdoutSha256 ?? createHash("sha256").update(logs.stdout).digest("hex"),
        stderrSha256: logs.stderrSha256 ?? createHash("sha256").update(logs.stderr).digest("hex"),
        timedOut: logs.timedOut,
        cancelled: logs.cancelled,
        ...(logs.timedOut || logs.cancelled ? { terminatedBy: logs.timedOut ? "timeout" as const : "cancel" as const } : {}),
        truncatedStdout: logs.truncatedStdout ?? false,
        truncatedStderr: logs.truncatedStderr ?? false,
        sandbox: { ...metadata, cleanup: cleanupOk ? "verified" : "failed" },
        ...(cleanupOk ? { sandboxFailureCode: "runtime_unavailable" as const, sandboxFailureMessage: logs.stderr || "Sandbox container logs failed" } : { sandboxFailureCode: "cleanup_failed" as const, sandboxFailureMessage: `Owned sandbox container cleanup failed for ${containerId}` }),
      };
    }
    const cleanupOk = await cleanup();
    const finalMetadata = { ...metadata, cleanup: cleanupOk ? "verified" as const : "failed" as const };
    return {
      exitCode: Number(parsedExitCode[1]),
      signal: null,
      stdout: logs.stdout,
      stderr: logs.stderr,
      stdoutBytes: logs.stdoutBytes ?? Buffer.byteLength(logs.stdout),
      stderrBytes: logs.stderrBytes ?? Buffer.byteLength(logs.stderr),
      stdoutSha256: logs.stdoutSha256 ?? createHash("sha256").update(logs.stdout).digest("hex"),
      stderrSha256: logs.stderrSha256 ?? createHash("sha256").update(logs.stderr).digest("hex"),
      timedOut: false,
      cancelled: false,
      truncatedStdout: logs.truncatedStdout ?? false,
      truncatedStderr: logs.truncatedStderr ?? false,
      sandbox: finalMetadata,
      ...(cleanupOk ? {} : { sandboxFailureCode: "cleanup_failed" as const, sandboxFailureMessage: `Owned sandbox container cleanup failed for ${containerId}` }),
    };
  } catch (error: unknown) {
    const cleanupOk = await cleanup();
    return { exitCode: null, signal: null, ...emptyOutput, timedOut: false, cancelled: request.abortSignal?.aborted === true, ...(request.abortSignal?.aborted ? { terminatedBy: "cancel" as const } : {}), truncatedStdout: false, truncatedStderr: false, sandbox: { ...metadataBase, ...(containerId ? { containerId } : {}), cleanup: cleanupOk ? "verified" : "failed" }, ...(cleanupOk ? { sandboxFailureCode: "runtime_unavailable" as const, sandboxFailureMessage: `Sandbox execution failed: ${(error as Error).message}` } : { sandboxFailureCode: "cleanup_failed" as const, sandboxFailureMessage: `Sandbox execution failed and cleanup failed: ${(error as Error).message}` }) };
  }
}
