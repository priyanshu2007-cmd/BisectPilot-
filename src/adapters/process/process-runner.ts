import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { CommandSpec, ExecutionPolicy, ToolchainWrapperSpec } from "../../contracts/index.js";
import { buildRestrictedEnvironment, buildSandboxEnvironment } from "./environment-policy.js";
import {
  runSandboxedProcess,
  type SandboxFailureCode,
  type SandboxMount,
  type SandboxRuntimeExecutor,
  type SandboxMetadata,
} from "./sandbox-runtime.js";

export interface ProcessRunOptions {
  readonly commandSpec: CommandSpec;
  readonly cwd: string;
  readonly executionPolicy: ExecutionPolicy;
  readonly abortSignal?: AbortSignal;
  readonly killGraceMs?: number;
  readonly detectedToolchainVersion?: string;
  readonly workspaceRoot?: string;
  readonly sandboxMounts?: readonly SandboxMount[];
  readonly sandboxAllowedReadOnlyRoots?: readonly string[];
  readonly sandboxOwnerId?: string;
  readonly sandboxRuntimeExecutor?: SandboxRuntimeExecutor;
  readonly sandboxOnContainerCreated?: (metadata: SandboxMetadata) => void | Promise<void>;
}

export function applyToolchainWrapper(
  commandSpec: CommandSpec,
  wrapper?: ToolchainWrapperSpec,
  detectedVersion?: string
): { readonly command: string; readonly args: readonly string[] } {
  if (!wrapper) {
    return { command: commandSpec.command, args: commandSpec.args };
  }
  const rawArgs = wrapper.args ?? [];
  const expandedArgs = rawArgs.map((arg) => {
    if (!detectedVersion) return arg;
    return arg.replace(/<version>/g, detectedVersion).replace(/\$\{version\}/g, detectedVersion);
  });
  return {
    command: wrapper.command,
    args: [...expandedArgs, commandSpec.command, ...commandSpec.args],
  };
}

export interface ProcessRunResult {
  readonly executable: string;
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | string | null;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly terminatedBy?: "timeout" | "cancel";
  readonly terminationSignalSent?: "SIGTERM" | "SIGKILL" | "taskkill";
  readonly spawnErrorCode?: string;
  readonly spawnErrorMessage?: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncatedStdout: boolean;
  readonly truncatedStderr: boolean;
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
  readonly stdoutBytes?: number;
  readonly stderrBytes?: number;
  readonly sandbox?: SandboxMetadata;
  readonly sandboxFailureCode?: SandboxFailureCode;
  readonly sandboxFailureMessage?: string;
  readonly orphanedProcessesKilled?: boolean;
}

export function terminateProcessTree(
  pid: number,
  graceMs: number,
  onSignalSent: (sig: "SIGTERM" | "SIGKILL" | "taskkill") => void,
  platformOverride?: NodeJS.Platform
): void {
  const platform = platformOverride ?? process.platform;
  if (platform === "win32") {
    onSignalSent("taskkill");
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      shell: false,
      stdio: "ignore",
    });
    killer.on("error", () => undefined);
    killer.unref();
    return;
  }

  try {
    onSignalSent("SIGTERM");
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
  }

  const killTimer = setTimeout(() => {
    try {
      process.kill(-pid, 0);
      onSignalSent("SIGKILL");
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, 0);
        onSignalSent("SIGKILL");
        process.kill(pid, "SIGKILL");
      } catch {
        // Already exited
      }
    }
  }, graceMs);
  killTimer.unref();
}

export async function runSafeProcess(options: ProcessRunOptions): Promise<ProcessRunResult> {
  const startTime = Date.now();
  const wrapped = applyToolchainWrapper(
    options.commandSpec,
    options.executionPolicy.toolchainWrapper,
    options.detectedToolchainVersion
  );
  const rawCommand = wrapped.command;
  const executable = rawCommand === "node" ? process.execPath : rawCommand;
  const args = [...wrapped.args];
  const maxBytes = options.executionPolicy.maxOutputBytesPerCommand;
  const graceMs = options.killGraceMs ?? 5_000;
  const isPosix = process.platform !== "win32";

  if (options.executionPolicy.sandbox) {
    if (!options.workspaceRoot) {
      return {
        executable,
        args,
        exitCode: null,
        signal: null,
        durationMs: Math.max(0, Date.now() - startTime),
        timedOut: false,
        cancelled: false,
        stdout: "",
        stderr: "",
        truncatedStdout: false,
        truncatedStderr: false,
        stdoutSha256: createHash("sha256").update("").digest("hex"),
        stderrSha256: createHash("sha256").update("").digest("hex"),
        sandboxFailureCode: "policy_rejected",
        sandboxFailureMessage: "Sandbox execution requires an approved workspaceRoot",
      };
    }
    const sandboxExecutable = rawCommand === "node" ? "node" : executable;
    const sandboxResult = await runSandboxedProcess({
      policy: options.executionPolicy.sandbox,
      workspaceRoot: options.workspaceRoot,
      cwd: options.cwd,
      command: sandboxExecutable,
      args,
      env: buildSandboxEnvironment(options.executionPolicy),
      mounts: options.sandboxMounts,
      allowedReadOnlyRoots: options.sandboxAllowedReadOnlyRoots,
      timeoutMs: options.commandSpec.timeoutMs,
      killGraceMs: graceMs,
      abortSignal: options.abortSignal,
      ownerId: options.sandboxOwnerId,
      executor: options.sandboxRuntimeExecutor,
      maxOutputBytes: maxBytes,
      onContainerCreated: options.sandboxOnContainerCreated,
    });
    const stdoutBuffer = Buffer.from(sandboxResult.stdout, "utf8");
    const stderrBuffer = Buffer.from(sandboxResult.stderr, "utf8");
    return {
      executable: sandboxExecutable,
      args,
      exitCode: sandboxResult.exitCode,
      signal: sandboxResult.signal,
      durationMs: Math.max(0, Date.now() - startTime),
      timedOut: sandboxResult.timedOut,
      cancelled: sandboxResult.cancelled,
      ...(sandboxResult.terminatedBy ? { terminatedBy: sandboxResult.terminatedBy } : {}),
      stdout: stdoutBuffer.subarray(0, maxBytes).toString("utf8"),
      stderr: stderrBuffer.subarray(0, maxBytes).toString("utf8"),
      truncatedStdout: stdoutBuffer.byteLength > maxBytes || sandboxResult.truncatedStdout,
      truncatedStderr: stderrBuffer.byteLength > maxBytes || sandboxResult.truncatedStderr,
      stdoutSha256: sandboxResult.stdoutSha256,
      stderrSha256: sandboxResult.stderrSha256,
      stdoutBytes: sandboxResult.stdoutBytes,
      stderrBytes: sandboxResult.stderrBytes,
      sandbox: sandboxResult.sandbox,
      ...(sandboxResult.sandboxFailureCode ? { sandboxFailureCode: sandboxResult.sandboxFailureCode } : {}),
      ...(sandboxResult.sandboxFailureMessage ? { sandboxFailureMessage: sandboxResult.sandboxFailureMessage } : {}),
    };
  }

  const env = buildRestrictedEnvironment(options.executionPolicy);

  return new Promise<ProcessRunResult>((resolve) => {
    const stdoutHash = createHash("sha256");
    const stderrHash = createHash("sha256");
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncatedStdout = false;
    let truncatedStderr = false;

    let timedOut = false;
    let cancelled = false;
    let terminatedBy: "timeout" | "cancel" | undefined;
    let terminationSignalSent: "SIGTERM" | "SIGKILL" | "taskkill" | undefined;
    let spawnErrorCode: string | undefined;
    let spawnErrorMessage: string | undefined;
    let settled = false;

    const child = spawn(executable, args, {
      cwd: options.cwd,
      env,
      shell: false,
      detached: isPosix,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const recordSignal = (sig: "SIGTERM" | "SIGKILL" | "taskkill") => {
      terminationSignalSent = sig;
    };

    const timeoutTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      terminatedBy = "timeout";
      if (child.pid !== undefined) {
        terminateProcessTree(child.pid, graceMs, recordSignal);
      }
    }, options.commandSpec.timeoutMs);

    const onAbort = () => {
      if (settled) return;
      cancelled = true;
      terminatedBy = "cancel";
      if (child.pid !== undefined) {
        terminateProcessTree(child.pid, graceMs, recordSignal);
      }
    };

    if (options.abortSignal) {
      if (options.abortSignal.aborted) {
        onAbort();
      } else {
        options.abortSignal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutHash.update(chunk);
      if (stdoutBytes < maxBytes) {
        const remaining = maxBytes - stdoutBytes;
        if (chunk.length <= remaining) {
          stdoutChunks.push(chunk);
          stdoutBytes += chunk.length;
        } else {
          stdoutChunks.push(chunk.subarray(0, remaining));
          stdoutBytes += remaining;
          truncatedStdout = true;
        }
      } else {
        truncatedStdout = true;
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrHash.update(chunk);
      if (stderrBytes < maxBytes) {
        const remaining = maxBytes - stderrBytes;
        if (chunk.length <= remaining) {
          stderrChunks.push(chunk);
          stderrBytes += chunk.length;
        } else {
          stderrChunks.push(chunk.subarray(0, remaining));
          stderrBytes += remaining;
          truncatedStderr = true;
        }
      } else {
        truncatedStderr = true;
      }
    });

    let recordedExitCode: number | null = null;
    let recordedSignal: NodeJS.Signals | string | null = null;
    let orphanedProcessesKilled = false;
    let drainTimer: NodeJS.Timeout | undefined;

    const cleanupOrphansAndDrain = (code: number | null, signal: NodeJS.Signals | string | null) => {
      recordedExitCode = code;
      recordedSignal = signal;
      clearTimeout(timeoutTimer);

      if (child.pid !== undefined) {
        if (isPosix) {
          let hasOrphans = false;
          try {
            process.kill(-child.pid, 0);
            hasOrphans = true;
          } catch {
            hasOrphans = false;
          }

          if (hasOrphans) {
            orphanedProcessesKilled = true;
            terminateProcessTree(child.pid, Math.min(graceMs, 1000), recordSignal);
          }
        } else {
          try {
            const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
              shell: false,
              stdio: "ignore",
            });
            killer.on("error", () => undefined);
            killer.unref();
          } catch {
            // Ignore
          }
        }
      }

      drainTimer = setTimeout(() => {
        finalize(recordedExitCode, recordedSignal);
      }, 1500);
      drainTimer.unref();
    };

    const finalize = (exitCode: number | null, signal: NodeJS.Signals | string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (drainTimer) clearTimeout(drainTimer);
      options.abortSignal?.removeEventListener("abort", onAbort);

      if (isPosix && child.pid !== undefined && (timedOut || cancelled)) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Process group already gone
        }
      }

      const durationMs = Math.max(0, Date.now() - startTime);
      resolve({
        executable,
        args,
        exitCode,
        signal,
        durationMs,
        timedOut,
        cancelled,
        ...(terminatedBy ? { terminatedBy } : {}),
        ...(terminationSignalSent ? { terminationSignalSent } : {}),
        ...(spawnErrorCode ? { spawnErrorCode } : {}),
        ...(spawnErrorMessage ? { spawnErrorMessage } : {}),
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        truncatedStdout,
        truncatedStderr,
        stdoutSha256: stdoutHash.digest("hex"),
        stderrSha256: stderrHash.digest("hex"),
        ...(orphanedProcessesKilled ? { orphanedProcessesKilled: true } : {}),
      });
    };

    child.on("error", (err: NodeJS.ErrnoException) => {
      spawnErrorCode = err.code ?? "SPAWN_ERROR";
      spawnErrorMessage = err.message;
      finalize(null, null);
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      if (!timedOut && !cancelled) {
        cleanupOrphansAndDrain(code, signal);
      }
    });

    child.on("close", (code, signal) => {
      if (drainTimer) clearTimeout(drainTimer);
      finalize(recordedExitCode ?? code, recordedSignal ?? signal);
    });
  });
}
