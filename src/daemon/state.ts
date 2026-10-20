import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_DAEMON_PORT } from "./constants.js";
import type { DaemonServiceOptions, DaemonState } from "./types.js";
import { checkKeyFilePermissions, computeCertFingerprint, isLoopbackHost } from "./security.js";

export function defaultDaemonStateDir(baseDir = "."): string {
  return path.resolve(baseDir, ".bisectpilot", "daemon");
}

export function daemonStatePath(stateDir: string): string {
  return path.join(path.resolve(stateDir), "daemon.json");
}

export function daemonQueuePath(stateDir: string): string {
  return path.join(path.resolve(stateDir), "jobs.json");
}

export function daemonTokenPath(stateDir: string): string {
  return path.join(path.resolve(stateDir), "daemon.token");
}

export function daemonLockPath(stateDir: string): string {
  return path.join(path.resolve(stateDir), "daemon.lock");
}

export function daemonRevocationsPath(stateDir: string): string {
  return path.join(path.resolve(stateDir), "revocations.json");
}

export function writeJsonAtomic(filePath: string, value: unknown, mode = 0o600): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, JSON.stringify(value, null, 2) + "\n", { encoding: "utf-8", mode });
  renameSync(tempPath, filePath);
}


export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function acquireDaemonLock(stateDir: string, recoverStale: boolean): string {
  const lockPath = daemonLockPath(stateDir);
  mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const nonce = randomBytes(16).toString("hex");
  const writeLock = () => writeFileSync(
    lockPath,
    JSON.stringify({ pid: process.pid, hostname: os.hostname(), nonce }) + "\n",
    { encoding: "utf-8", mode: 0o600, flag: "wx" }
  );
  try {
    writeLock();
    return nonce;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let holder: { pid?: unknown } = {};
    try {
      holder = JSON.parse(readFileSync(lockPath, "utf-8")) as { pid?: unknown };
    } catch {
      // A malformed lock is stale, but only --recover may replace it.
    }
    if (typeof holder.pid === "number" && isPidAlive(holder.pid)) {
      throw new Error(`Daemon lock is held by active PID ${holder.pid}`);
    }
    if (!recoverStale) throw new Error(`Stale daemon lock detected at ${lockPath}; rerun with --recover`);
    rmSync(lockPath, { force: true });
    writeLock();
    return nonce;
  }
}

export function validateTiming(value: number | undefined, name: string, minimum: number): number {
  const resolved = value ?? minimum;
  if (!Number.isInteger(resolved) || resolved < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
  return resolved;
}

export function validateDaemonOptions(options: DaemonServiceOptions): {
  readonly host: string;
  readonly port: number;
  readonly leaseMs: number;
  readonly heartbeatMs: number;
  readonly tokenFile: string;
  readonly protocol: "http" | "https";
  readonly tlsRequireClientCert: boolean;
} {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? DEFAULT_DAEMON_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("Daemon port must be an integer from 0 to 65535");
  const leaseMs = validateTiming(options.leaseMs, "leaseMs", 5_000);
  const heartbeatMs = validateTiming(options.heartbeatMs, "heartbeatMs", 1_000);
  if (heartbeatMs >= leaseMs / 2) throw new Error("heartbeatMs must be less than half of leaseMs");
  const hasCert = Boolean(options.tlsCertFile);
  const hasKey = Boolean(options.tlsKeyFile);
  if (hasCert !== hasKey) throw new Error("TLS requires both --tls-cert and --tls-key");
  if (hasCert) {
    if (!existsSync(options.tlsCertFile!)) throw new Error(`TLS cert file not found: ${options.tlsCertFile}`);
    checkKeyFilePermissions(options.tlsKeyFile!);
  }
  if (!isLoopbackHost(host)) {
    if (!hasCert) throw new Error("Refusing non-loopback daemon bind without TLS certificate and key");
    if (!options.tlsCaFile) throw new Error("Refusing non-loopback daemon bind without client CA certificate (--tls-ca) for mutual TLS");
  }
  if (options.tlsCaFile && !existsSync(options.tlsCaFile)) {
    throw new Error(`TLS CA file not found: ${options.tlsCaFile}`);
  }
  const requireClientCert = Boolean(options.tlsRequireClientCert || !isLoopbackHost(host));
  if (requireClientCert && !options.tlsCaFile) {
    throw new Error("Client certificate verification requires --tls-ca");
  }
  return {
    host,
    port,
    leaseMs,
    heartbeatMs,
    tokenFile: path.resolve(options.tokenFile ?? daemonTokenPath(options.stateDir)),
    protocol: hasCert ? "https" : "http",
    tlsRequireClientCert: requireClientCert,
  };
}


export function readDaemonState(stateDir: string): DaemonState {
  const filePath = daemonStatePath(stateDir);
  if (!existsSync(filePath)) throw new Error(`Daemon state not found at ${filePath}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    throw new Error(`Corrupt daemon state at ${filePath}`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    typeof (parsed as { pid?: unknown }).pid !== "number" ||
    typeof (parsed as { port?: unknown }).port !== "number" ||
    typeof (parsed as { state?: unknown }).state !== "string"
  ) {
    throw new Error(`Invalid daemon state at ${filePath}`);
  }
  return parsed as DaemonState;
}
