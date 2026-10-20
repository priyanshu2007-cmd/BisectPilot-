import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalBisectEngine } from "../application/index.js";
import type { BisectConfigV1, BisectEngine } from "../contracts/index.js";
import { loadConfigFromFile } from "../config/index.js";
import { DaemonClient, daemonBaseUrl } from "./client.js";
import {
  DaemonService,
  daemonStatePath,
  defaultDaemonStateDir,
  readDaemonState,
} from "./index.js";

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function numberAfter(args: readonly string[], flag: string, fallback: number): number {
  const raw = valueAfter(args, flag);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${flag} must be an integer`);
  return value;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function allValuesAfter(args: readonly string[], flag: string): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1] && !args[i + 1]!.startsWith("--")) {
      result.push(args[i + 1]!);
      i++;
    }
  }
  return result;
}

function commonDaemonArgs(args: readonly string[], stateDir: string): string[] {
  const result = ["--state-dir", stateDir];
  for (const flag of ["--host", "--port", "--token-file", "--lease-ms", "--heartbeat-ms", "--tls-cert", "--tls-key", "--tls-ca"] as const) {
    const value = valueAfter(args, flag);
    if (value !== undefined) result.push(flag, value);
  }
  if (args.includes("--tls-require-client-cert")) result.push("--tls-require-client-cert");
  for (const id of allValuesAfter(args, "--tls-allowed-identity")) result.push("--tls-allowed-identity", id);
  for (const fp of allValuesAfter(args, "--tls-revoked-fingerprint")) result.push("--tls-revoked-fingerprint", fp);
  if (args.includes("--recover")) result.push("--recover");
  return result;
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForDaemonState(stateDir: string, expected: "running" | "stopped"): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    try {
      if (readDaemonState(stateDir).state === expected) return true;
    } catch {
      // Child process has not written state yet.
    }
    await sleep(50);
  }
  return false;
}

function daemonEntryPoint(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../index.js");
}

async function runDaemonForeground(args: readonly string[]): Promise<number> {
  const stateDir = path.resolve(valueAfter(args, "--state-dir") ?? defaultDaemonStateDir());
  const service = new DaemonService({
    stateDir,
    host: valueAfter(args, "--host"),
    port: numberAfter(args, "--port", 4317),
    tokenFile: valueAfter(args, "--token-file"),
    leaseMs: numberAfter(args, "--lease-ms", 30_000),
    heartbeatMs: numberAfter(args, "--heartbeat-ms", 5_000),
    tlsCertFile: valueAfter(args, "--tls-cert"),
    tlsKeyFile: valueAfter(args, "--tls-key"),
    tlsCaFile: valueAfter(args, "--tls-ca"),
    tlsRequireClientCert: args.includes("--tls-require-client-cert"),
    tlsAllowedIdentities: allValuesAfter(args, "--tls-allowed-identity").length > 0 ? allValuesAfter(args, "--tls-allowed-identity") : undefined,
    tlsRevokedFingerprints: allValuesAfter(args, "--tls-revoked-fingerprint").length > 0 ? allValuesAfter(args, "--tls-revoked-fingerprint") : undefined,
    recoverStaleState: args.includes("--recover"),
  });
  await service.start();
  const shutdown = () => void service.stop("Daemon signal received").catch(() => undefined);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  while (true) {
    await sleep(250);
    try {
      const state = readDaemonState(stateDir);
      if (state.state === "stopped" || state.state === "failed") break;
    } catch {
      break;
    }
  }
  process.removeListener("SIGINT", shutdown);
  process.removeListener("SIGTERM", shutdown);
  return 0;
}

async function startDaemon(args: readonly string[]): Promise<number> {
  const stateDir = path.resolve(valueAfter(args, "--state-dir") ?? defaultDaemonStateDir());
  if (args.includes("--foreground")) return runDaemonForeground(args);
  if (existsSync(daemonStatePath(stateDir))) {
    const previous = readDaemonState(stateDir);
    if (previous.state === "running") {
      if (pidAlive(previous.pid)) throw new Error(`Daemon state already exists at ${daemonStatePath(stateDir)}; use status or stop first`);
      if (!args.includes("--recover")) throw new Error(`Stale daemon state detected at ${daemonStatePath(stateDir)}; rerun with --recover`);
    }
    if (previous.state === "recovery_required" && !args.includes("--recover")) {
      throw new Error(`Stale daemon state detected at ${daemonStatePath(stateDir)}; rerun with --recover`);
    }
  }
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(stateDir, "daemon.log");
  const logFd = openSync(logPath, "a");
  try {
    const child = spawn(process.execPath, [daemonEntryPoint(), "daemon", "run", ...commonDaemonArgs(args, stateDir)], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }
  if (!(await waitForDaemonState(stateDir, "running"))) {
    throw new Error(`Daemon did not reach running state; inspect ${logPath}`);
  }
  process.stdout.write(`Daemon started: ${daemonStatePath(stateDir)}\n`);
  return 0;
}

async function daemonStatus(args: readonly string[]): Promise<number> {
  const stateDir = path.resolve(valueAfter(args, "--state-dir") ?? defaultDaemonStateDir());
  const state = readDaemonState(stateDir);
  try {
    const client = new DaemonClient({ baseUrl: daemonBaseUrl(state), tokenFile: state.tokenFile });
    process.stdout.write(JSON.stringify(await client.status(), null, 2) + "\n");
    return state.state === "running" ? 0 : 1;
  } catch (error: unknown) {
    process.stdout.write(JSON.stringify({ state, reachable: false, error: (error as Error).message }, null, 2) + "\n");
    return state.state === "stopped" ? 0 : 1;
  }
}

async function daemonStop(args: readonly string[]): Promise<number> {
  const stateDir = path.resolve(valueAfter(args, "--state-dir") ?? defaultDaemonStateDir());
  const state = readDaemonState(stateDir);
  if (state.state !== "running") {
    process.stdout.write(JSON.stringify(state, null, 2) + "\n");
    return state.state === "stopped" ? 0 : 1;
  }
  const client = new DaemonClient({ baseUrl: daemonBaseUrl(state), tokenFile: state.tokenFile });
  await client.shutdown();
  if (!(await waitForDaemonState(stateDir, "stopped"))) throw new Error("Daemon did not stop cleanly; no process was force-killed");
  process.stdout.write(`Daemon stopped: ${stateDir}\n`);
  return 0;
}

export async function enqueueBisectJob(
  config: BisectConfigV1,
  stateDir: string,
  repositoryKey = "default",
  engine: BisectEngine = new LocalBisectEngine()
): Promise<Record<string, unknown>> {
  if (config.goodRef === "auto") throw new Error("Async jobs require an explicit goodRef; automatic discovery remains foreground-only");
  const plan = await engine.plan(config);
  if (!plan.ok) throw new Error(`Cannot enqueue bisection plan: ${plan.warnings.join("; ") || "invalid bounds"}`);
  const state = readDaemonState(stateDir);
  const client = new DaemonClient({ baseUrl: daemonBaseUrl(state), tokenFile: state.tokenFile });
  const asyncConfig: BisectConfigV1 = {
    ...config,
    execution: { ...config.execution, confirmBeforeExecutingCode: false },
  };
  const response = await client.enqueue({
    config: asyncConfig,
    repository: {
      strategy: "preprovisioned",
      key: repositoryKey,
      expectedGoodSha: plan.goodSha,
      expectedBadSha: plan.badSha,
    },
  });
  return response.job;
}

async function daemonEnqueue(args: readonly string[], engine: BisectEngine): Promise<number> {
  const configPath = valueAfter(args, "--config");
  if (!configPath) throw new Error("Missing --config <path>");
  const loaded = loadConfigFromFile(configPath);
  if (!loaded.ok) throw new Error(loaded.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
  if (loaded.value.execution.confirmBeforeExecutingCode && !args.includes("--yes")) {
    throw new Error("Refusing to enqueue historical repository code without --yes consent flag");
  }
  const stateDir = path.resolve(valueAfter(args, "--state-dir") ?? defaultDaemonStateDir());
  const job = await enqueueBisectJob(loaded.value, stateDir, valueAfter(args, "--repository-key") ?? "default", engine);
  process.stdout.write(JSON.stringify(job, null, 2) + "\n");
  return 0;
}

export async function runDaemonCommand(args: readonly string[], engine: BisectEngine = new LocalBisectEngine()): Promise<number> {
  const action = args[0];
  if (action === "run") return runDaemonForeground(args.slice(1));
  if (action === "start") return startDaemon(args.slice(1));
  if (action === "status") return daemonStatus(args.slice(1));
  if (action === "stop") return daemonStop(args.slice(1));
  if (action === "enqueue") return daemonEnqueue(args.slice(1), engine);
  if (action === "cancel" || action === "recover") {
    const jobId = args[1];
    if (!jobId) throw new Error(`Missing <jobId> for daemon ${action}`);
    const stateDir = path.resolve(valueAfter(args.slice(1), "--state-dir") ?? defaultDaemonStateDir());
    const state = readDaemonState(stateDir);
    const client = new DaemonClient({ baseUrl: daemonBaseUrl(state), tokenFile: state.tokenFile });
    const result = action === "cancel"
      ? await client.cancel(jobId, valueAfter(args.slice(1), "--reason"))
      : await client.recover(jobId, valueAfter(args.slice(1), "--reason"));
    process.stdout.write(JSON.stringify(result.job, null, 2) + "\n");
    return 0;
  }
  if (action === "revoke") {
    const stateDir = path.resolve(valueAfter(args.slice(1), "--state-dir") ?? defaultDaemonStateDir());
    const fingerprint = valueAfter(args.slice(1), "--fingerprint");
    const workerId = valueAfter(args.slice(1), "--worker-id");
    const reason = valueAfter(args.slice(1), "--reason");
    if (!fingerprint && !workerId) throw new Error("daemon revoke requires --fingerprint <sha256> or --worker-id <id>");
    const state = readDaemonState(stateDir);
    const client = new DaemonClient({ baseUrl: daemonBaseUrl(state), tokenFile: state.tokenFile });
    const result = await client.revoke({ fingerprint, workerId, reason });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }
  throw new Error("Usage: bisectpilot daemon start|status|stop|enqueue|cancel|recover|revoke");
}
