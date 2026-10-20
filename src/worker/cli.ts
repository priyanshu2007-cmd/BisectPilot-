import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import * as http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BisectEngine } from "../contracts/index.js";
import { WorkerService, defaultWorkerStateDir, readWorkerState, workerStatePath } from "./index.js";

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

function repositoryMappings(args: readonly string[]): Record<string, string> {
  const mappings: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--repo") continue;
    const raw = args[i + 1];
    if (!raw) throw new Error("Missing --repo <key=absolute-path>");
    const separator = raw.indexOf("=");
    if (separator <= 0 || separator === raw.length - 1) throw new Error("--repo must use <key=absolute-path>");
    mappings[raw.slice(0, separator)] = path.resolve(raw.slice(separator + 1));
    i++;
  }
  return mappings;
}

function commonWorkerArgs(args: readonly string[], stateDir: string): string[] {
  const result = ["--state-dir", stateDir];
  for (const flag of ["--server", "--token-file", "--poll-ms", "--heartbeat-ms", "--tls-cert", "--tls-key", "--tls-ca", "--tls-servername", "--worker-id"] as const) {
    const value = valueAfter(args, flag);
    if (value !== undefined) result.push(flag, value);
  }
  const mappings = repositoryMappings(args);
  for (const [key, value] of Object.entries(mappings)) result.push("--repo", `${key}=${value}`);
  if (args.includes("--recover")) result.push("--recover");
  return result;
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function workerEntryPoint(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../index.js");
}

async function waitForWorkerState(stateDir: string, expected: "running" | "stopped"): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    try {
      if (readWorkerState(stateDir).state === expected) return true;
    } catch {
      // Child process has not written state yet.
    }
    await sleep(50);
  }
  return false;
}

async function runWorkerForeground(args: readonly string[], engine?: BisectEngine): Promise<number> {
  const stateDir = path.resolve(valueAfter(args, "--state-dir") ?? defaultWorkerStateDir());
  const serverUrl = valueAfter(args, "--server");
  const daemonTokenFile = valueAfter(args, "--token-file");
  if (!serverUrl || !daemonTokenFile) throw new Error("worker start requires --server <url> and --token-file <path>");
  const service = new WorkerService({
    stateDir,
    serverUrl,
    daemonTokenFile: path.resolve(daemonTokenFile),
    repositories: repositoryMappings(args),
    pollMs: numberAfter(args, "--poll-ms", 2_000),
    heartbeatMs: numberAfter(args, "--heartbeat-ms", 5_000),
    tlsCertFile: valueAfter(args, "--tls-cert"),
    tlsKeyFile: valueAfter(args, "--tls-key"),
    tlsCaFile: valueAfter(args, "--tls-ca"),
    tlsServername: valueAfter(args, "--tls-servername"),
    workerId: valueAfter(args, "--worker-id"),
    engine,
    recoverStaleState: args.includes("--recover"),
  });
  await service.start();
  const shutdown = () => void service.stop("Worker signal received").catch(() => undefined);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await service.waitForStop();
  process.removeListener("SIGINT", shutdown);
  process.removeListener("SIGTERM", shutdown);
  return 0;
}

async function startWorker(args: readonly string[], engine?: BisectEngine): Promise<number> {
  const stateDir = path.resolve(valueAfter(args, "--state-dir") ?? defaultWorkerStateDir());
  if (args.includes("--foreground")) return runWorkerForeground(args, engine);
  if (existsSync(workerStatePath(stateDir))) {
    const previous = readWorkerState(stateDir);
    if (previous.state === "running") throw new Error(`Worker state already exists at ${workerStatePath(stateDir)}`);
    if (previous.state !== "stopped" && !args.includes("--recover")) {
      throw new Error(`Stale worker state detected at ${workerStatePath(stateDir)}; rerun with --recover`);
    }
  }
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(stateDir, "worker.log");
  const logFd = openSync(logPath, "a");
  try {
    const child = spawn(process.execPath, [workerEntryPoint(), "worker", "run", ...commonWorkerArgs(args, stateDir)], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }
  if (!(await waitForWorkerState(stateDir, "running"))) throw new Error(`Worker did not reach running state; inspect ${logPath}`);
  process.stdout.write(`Worker started: ${workerStatePath(stateDir)}\n`);
  return 0;
}

function requestWorkerStop(state: ReturnType<typeof readWorkerState>): Promise<void> {
  const token = readFileSync(state.tokenFile, "utf-8").trim();
  return new Promise<void>((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: state.controlPort,
        path: "/shutdown",
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      },
      (res) => {
        res.resume();
        res.on("end", () => (res.statusCode && res.statusCode >= 200 && res.statusCode < 300 ? resolve() : reject(new Error(`Worker stop rejected (${res.statusCode})`))));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function workerStatus(args: readonly string[]): Promise<number> {
  const stateDir = path.resolve(valueAfter(args, "--state-dir") ?? defaultWorkerStateDir());
  const state = readWorkerState(stateDir);
  process.stdout.write(JSON.stringify(state, null, 2) + "\n");
  return state.state === "running" ? 0 : 1;
}

async function workerStop(args: readonly string[]): Promise<number> {
  const stateDir = path.resolve(valueAfter(args, "--state-dir") ?? defaultWorkerStateDir());
  const state = readWorkerState(stateDir);
  if (state.state !== "running") {
    process.stdout.write(JSON.stringify(state, null, 2) + "\n");
    return state.state === "stopped" ? 0 : 1;
  }
  await requestWorkerStop(state);
  if (!(await waitForWorkerState(stateDir, "stopped"))) throw new Error("Worker did not stop cleanly");
  process.stdout.write(`Worker stopped: ${stateDir}\n`);
  return 0;
}

export async function runWorkerCommand(args: readonly string[], engine?: BisectEngine): Promise<number> {
  const action = args[0];
  if (action === "run") return runWorkerForeground(args.slice(1), engine);
  if (action === "start") return startWorker(args.slice(1), engine);
  if (action === "status") return workerStatus(args.slice(1));
  if (action === "stop") return workerStop(args.slice(1));
  throw new Error("Usage: bisectpilot worker start|status|stop");
}
