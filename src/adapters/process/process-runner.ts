import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { CommandSpec, ExecutionPolicy } from "../../contracts/index.js";
import { buildRestrictedEnvironment } from "./environment-policy.js";

export interface ProcessRunOptions {
  readonly commandSpec: CommandSpec;
  readonly cwd: string;
  readonly executionPolicy: ExecutionPolicy;
  readonly abortSignal?: AbortSignal;
  readonly killGraceMs?: number;
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
}

function terminateProcessTree(
  pid: number,
  graceMs: number,
  onSignalSent: (sig: "SIGTERM" | "SIGKILL" | "taskkill") => void
): void {
  if (process.platform === "win32") {
    onSignalSent("taskkill");
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      shell: false,
      stdio: "ignore",
    });
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
  const rawCommand = options.commandSpec.command;
  const executable = rawCommand === "node" ? process.execPath : rawCommand;
  const args = [...options.commandSpec.args];
  const maxBytes = options.executionPolicy.maxOutputBytesPerCommand;
  const graceMs = options.killGraceMs ?? 5_000;
  const isPosix = process.platform !== "win32";

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

    const finalize = (exitCode: number | null, signal: NodeJS.Signals | string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
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
      });
    };

    child.on("error", (err: NodeJS.ErrnoException) => {
      spawnErrorCode = err.code ?? "SPAWN_ERROR";
      spawnErrorMessage = err.message;
      finalize(null, null);
    });

    child.on("close", (code, signal) => {
      finalize(code, signal);
    });
  });
}
