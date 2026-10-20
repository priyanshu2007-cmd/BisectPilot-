import { randomBytes, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as tls from "node:tls";
import os from "node:os";
import path from "node:path";
import {
  JOB_PROTOCOL_VERSION,
  AtomicJobStore,
  isValidSessionConclusion,
  validateAsyncJobPayload,
  summarizeJob,
} from "../jobs/index.js";
import {
  defaultMetricsRegistry,
  defaultMetrics,
  parseTraceParent,
  getTracer,
  isTracingEnabled,
} from "../telemetry/index.js";
import type {
  BisectJobPayload,
  JobRecord,
  JobType,
  WorkerCapabilities,
  JobResult,
} from "../contracts/index.js";
import {
  detectCrashNeedsRecovery,
  listSessionManifests,
  resolveSessionRoot,
  TERMINAL_SESSION_STATES,
} from "../session/index.js";
import {
  DEFAULT_DAEMON_PORT,
  DEFAULT_LEASE_MS,
  DEFAULT_HEARTBEAT_MS,
  MAX_REQUEST_BYTES,
  REQUEST_TIMEOUT_MS,
} from "./constants.js";
import type {
  DaemonLifecycleState,
  DaemonTlsState,
  DaemonState,
  DaemonServiceOptions,
  RegisteredWorker,
  DaemonTelemetryStatus,
  DaemonStatus,
  ClientIdentity,
} from "./types.js";
import {
  checkKeyFilePermissions,
  computeCertFingerprint,
  isLoopbackHost,
  isLoopbackAddress,
  readProtectedToken,
  sameToken,
  extractClientIdentity,
} from "./security.js";
import {
  defaultDaemonStateDir,
  daemonStatePath,
  daemonQueuePath,
  daemonTokenPath,
  daemonLockPath,
  daemonRevocationsPath,
  writeJsonAtomic,
  isPidAlive,
  acquireDaemonLock,
  validateTiming,
  validateDaemonOptions,
  readDaemonState,
} from "./state.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const declaredLength = req.headers["content-length"];
  if (declaredLength && Number(declaredLength) > MAX_REQUEST_BYTES) throw new Error("Request body exceeds size limit");
  return await new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_REQUEST_BYTES) {
        if (!rejected) {
          rejected = true;
          reject(new Error("Request body exceeds size limit"));
        }
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (rejected) return;
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Request body must be valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function parseWorkerCapabilities(value: unknown):
  | { ok: true; capabilities: WorkerCapabilities }
  | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "Worker registration must be an object" };
  const validJobTypes = new Set(["bisect", "sample_evaluation", "benchmark_sample"]);
  if (
    typeof value.workerId !== "string" ||
    value.workerId.length < 1 ||
    value.workerId.length > 128 ||
    value.protocolVersion !== JOB_PROTOCOL_VERSION ||
    !Array.isArray(value.jobTypes) ||
    !value.jobTypes.every((item) => typeof item === "string" && validJobTypes.has(item)) ||
    !Array.isArray(value.repositoryKeys) ||
    !value.repositoryKeys.every((item) => typeof item === "string" && item.length > 0 && item.length <= 128) ||
    typeof value.platform !== "string" ||
    typeof value.architecture !== "string" ||
    typeof value.maxConcurrentJobs !== "number" ||
    !Number.isInteger(value.maxConcurrentJobs) ||
    value.maxConcurrentJobs < 1 ||
    value.maxConcurrentJobs > 64 ||
    (value.sandboxRuntimes !== undefined && (!Array.isArray(value.sandboxRuntimes) || !value.sandboxRuntimes.every((item) => item === "docker" || item === "podman"))) ||
    (value.supportedProfiles !== undefined && (!Array.isArray(value.supportedProfiles) || !value.supportedProfiles.every((p) => typeof p === "string"))) ||
    (value.features !== undefined && (!Array.isArray(value.features) || !value.features.every((f) => f === "workspace" || f === "noisy" || f === "benchmark"))) ||
    (value.environmentIdentity !== undefined && (!isRecord(value.environmentIdentity) || typeof value.environmentIdentity.platform !== "string" || typeof value.environmentIdentity.architecture !== "string"))
  ) {
    return { ok: false, error: "Invalid worker capabilities" };
  }
  return {
    ok: true,
    capabilities: {
      workerId: value.workerId,
      protocolVersion: 1,
      jobTypes: value.jobTypes as JobType[],
      repositoryKeys: value.repositoryKeys,
      platform: value.platform,
      architecture: value.architecture,
      maxConcurrentJobs: value.maxConcurrentJobs,
      ...(Array.isArray(value.sandboxRuntimes) ? { sandboxRuntimes: value.sandboxRuntimes } : {}),
      ...(Array.isArray(value.supportedProfiles) ? { supportedProfiles: value.supportedProfiles as ("functional" | "performance")[] } : {}),
      ...(Array.isArray(value.features) ? { features: value.features as ("workspace" | "noisy" | "benchmark")[] } : {}),
      ...(isRecord(value.environmentIdentity)
        ? {
            environmentIdentity: {
              platform: String(value.environmentIdentity.platform),
              architecture: String(value.environmentIdentity.architecture),
              ...(typeof value.environmentIdentity.nodeVersion === "string" ? { nodeVersion: value.environmentIdentity.nodeVersion } : {}),
              ...(typeof value.environmentIdentity.containerImageDigest === "string" ? { containerImageDigest: value.environmentIdentity.containerImageDigest } : {}),
            },
          }
        : {}),
    },
  };
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload) + "\n";
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(body));
  res.end(body);
}


export class DaemonService {
  readonly stateDir: string;
  readonly queue: AtomicJobStore;
  private readonly options: DaemonServiceOptions;
  private readonly now: () => Date;
  private readonly workers = new Map<string, RegisteredWorker>();
  private readonly revokedFingerprints = new Set<string>();
  private readonly revokedWorkers = new Set<string>();
  private server?: http.Server;
  private token = "";
  private state?: DaemonState;
  private lockNonce?: string;

  constructor(options: DaemonServiceOptions) {
    this.options = options;
    this.stateDir = path.resolve(options.stateDir);
    this.queue = new AtomicJobStore(daemonQueuePath(this.stateDir));
    this.now = options.now ?? (() => new Date());

    if (options.tlsRevokedFingerprints) {
      for (const fp of options.tlsRevokedFingerprints) {
        this.revokedFingerprints.add(fp.trim().toUpperCase());
      }
    }
    const revPath = daemonRevocationsPath(this.stateDir);
    if (existsSync(revPath)) {
      try {
        const stored = JSON.parse(readFileSync(revPath, "utf-8")) as {
          fingerprints?: string[];
          workers?: string[];
        };
        if (Array.isArray(stored.fingerprints)) {
          for (const fp of stored.fingerprints) this.revokedFingerprints.add(fp.toUpperCase());
        }
        if (Array.isArray(stored.workers)) {
          for (const w of stored.workers) this.revokedWorkers.add(w);
        }
      } catch {
        // Corrupt revocations file ignored on load; will be overwritten on next revocation
      }
    }
  }

  revokeClientCertificate(fingerprint: string, _reason?: string): void {
    const normalized = fingerprint.trim().toUpperCase();
    this.revokedFingerprints.add(normalized);
    this.persistRevocations();
    for (const [id, worker] of this.workers.entries()) {
      if (worker.clientCertFingerprint?.toUpperCase() === normalized) {
        this.workers.delete(id);
      }
    }
    this.updateWorkerGauges();
  }

  revokeWorker(workerId: string, _reason?: string): void {
    this.revokedWorkers.add(workerId);
    this.persistRevocations();
    this.workers.delete(workerId);
    this.updateWorkerGauges();
  }

  rotateServerTls(newOptions: { certFile: string; keyFile: string; caFile?: string }): void {
    if (!this.server || !(this.server instanceof https.Server)) {
      throw new Error("Cannot rotate TLS on a non-HTTPS server");
    }
    if (!existsSync(newOptions.certFile)) throw new Error(`Cert file not found: ${newOptions.certFile}`);
    checkKeyFilePermissions(newOptions.keyFile);
    if (newOptions.caFile && !existsSync(newOptions.caFile)) throw new Error(`CA file not found: ${newOptions.caFile}`);

    const cert = readFileSync(path.resolve(newOptions.certFile));
    const key = readFileSync(path.resolve(newOptions.keyFile));
    const ca = newOptions.caFile ? readFileSync(path.resolve(newOptions.caFile)) : undefined;

    tls.createSecureContext({ cert, key, ...(ca ? { ca } : {}) });
    this.server.setSecureContext({ cert, key, ...(ca ? { ca } : {}) });
  }

  private persistRevocations(): void {
    const filePath = daemonRevocationsPath(this.stateDir);
    writeJsonAtomic(filePath, {
      fingerprints: [...this.revokedFingerprints],
      workers: [...this.revokedWorkers],
    });
  }

  async recoverActiveSessions(sessionRootDir?: string): Promise<number> {
    const baseDir = await resolveSessionRoot(sessionRootDir);
    if (!existsSync(baseDir)) return 0;
    let recoveredCount = 0;
    try {
      const manifests = listSessionManifests(baseDir);
      for (const m of manifests) {
        if (!TERMINAL_SESSION_STATES.has(m.state) && m.state !== "concluded") {
          const checked = detectCrashNeedsRecovery(m);
          if (checked.state === "needs_recovery") {
            recoveredCount++;
          }
        }
      }
    } catch {
      // Non-fatal
    }
    return recoveredCount;
  }

  async start(): Promise<DaemonState> {
    if (this.server) throw new Error("Daemon is already running in this process");
    const config = validateDaemonOptions(this.options);
    this.lockNonce = acquireDaemonLock(this.stateDir, Boolean(this.options.recoverStaleState));
    try {
      const previous = existsSync(daemonStatePath(this.stateDir)) ? readDaemonState(this.stateDir) : undefined;
      if (previous && previous.state === "running" && previous.pid !== process.pid && isPidAlive(previous.pid)) {
        throw new Error(`Daemon already running at ${previous.host}:${previous.port} (PID ${previous.pid})`);
      }
      if (previous && previous.state === "running" && previous.pid !== process.pid && !this.options.recoverStaleState) {
        throw new Error(`Stale daemon state detected at ${daemonStatePath(this.stateDir)}; rerun with --recover`);
      }

      this.token = readProtectedToken(config.tokenFile);
      mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
      this.queue.recoverAfterDaemonRestart(this.now());
      await this.recoverActiveSessions();
      const startedAt = this.now().toISOString();
      this.state = this.buildState(config, "starting", startedAt);
      this.persistState(this.state);

      const requestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => {
        void this.handleRequest(req, res);
      };
      if (config.protocol === "https") {
        this.server = https.createServer(
          {
            cert: readFileSync(path.resolve(this.options.tlsCertFile!)),
            key: readFileSync(path.resolve(this.options.tlsKeyFile!)),
            ...(this.options.tlsCaFile ? { ca: readFileSync(path.resolve(this.options.tlsCaFile)) } : {}),
            requestCert: config.tlsRequireClientCert,
            rejectUnauthorized: config.tlsRequireClientCert,
          },
          requestHandler
        );
      } else {
        this.server = http.createServer(requestHandler);
      }
      const server = this.server;
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(config.port, config.host);
      });
      const address = server.address();
      const actualPort = typeof address === "object" && address !== null ? address.port : config.port;
      this.state = this.buildState({ ...config, port: actualPort }, "running", startedAt);
      this.persistState(this.state);
      this.updateWorkerGauges();
      return this.state;
    } catch (error: unknown) {
      if (this.state?.state === "starting") {
        this.state = this.buildState(config, "failed", this.state.startedAt, (error as Error).message);
        this.persistState(this.state);
        this.server = undefined;
        this.releaseDaemonLock();
        throw new Error(`Daemon failed to start: ${(error as Error).message}`);
      }
      this.releaseDaemonLock();
      throw error;
    }
  }

  async stop(reason = "Daemon shutdown requested"): Promise<DaemonState> {
    const current = this.state ?? (existsSync(daemonStatePath(this.stateDir)) ? readDaemonState(this.stateDir) : undefined);
    if (!current) throw new Error(`Daemon state not found at ${daemonStatePath(this.stateDir)}`);
    this.queue.recoverAfterDaemonRestart(this.now());
    const stopping = { ...current, state: "stopping" as const, updatedAt: this.now().toISOString(), lastError: reason };
    this.state = stopping;
    this.persistState(stopping);
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = undefined;
    }
    const stopped = { ...stopping, state: "stopped" as const, updatedAt: this.now().toISOString() };
    this.state = stopped;
    this.persistState(stopped);
    defaultMetrics.registeredWorkers.set(0, { state: "available" });
    defaultMetrics.registeredWorkers.set(0, { state: "busy" });
    this.releaseDaemonLock();
    return stopped;
  }

  status(): DaemonStatus {
    const state = this.state ?? readDaemonState(this.stateDir);
    return {
      state,
      pidAlive: isPidAlive(state.pid),
      queue: this.queue.summary(),
      jobs: this.queue.list().map(summarizeJob),
      workers: [...this.workers.values()],
      telemetry: {
        tracingEnabled: isTracingEnabled(),
        metricsActive: true,
        metricsEndpoint: "/metrics",
      },
    };
  }

  private updateWorkerGauges(): void {
    const activeJobs = this.queue.list().filter((j) => j.state === "leased" || j.state === "running");
    let availableCount = 0;
    let busyCount = 0;
    let totalCapacity = 0;
    for (const worker of this.workers.values()) {
      const maxJobs = worker.capabilities.maxConcurrentJobs ?? 1;
      totalCapacity += maxJobs;
      const workerActiveCount = activeJobs.filter((j) => j.assignedWorkerId === worker.capabilities.workerId).length;
      if (workerActiveCount >= maxJobs) {
        busyCount++;
      } else {
        availableCount++;
      }
    }
    defaultMetrics.registeredWorkers.set(availableCount, { state: "available" });
    defaultMetrics.registeredWorkers.set(busyCount, { state: "busy" });
    defaultMetrics.workerConcurrencyCapacity.set(totalCapacity);
    defaultMetrics.workerConcurrencyUtilized.set(activeJobs.length);
  }

  private buildState(
    config: ReturnType<typeof validateDaemonOptions>,
    state: DaemonLifecycleState,
    startedAt: string,
    lastError?: string
  ): DaemonState {
    const tlsState: DaemonTlsState | undefined = config.protocol === "https" ? {
      enabled: true,
      clientAuthRequired: config.tlsRequireClientCert,
      serverCertFingerprint: this.options.tlsCertFile ? computeCertFingerprint(this.options.tlsCertFile) : undefined,
      ...(this.options.tlsAllowedIdentities ? { allowedIdentities: this.options.tlsAllowedIdentities } : {}),
      revokedFingerprintsCount: this.revokedFingerprints.size,
      revokedWorkersCount: this.revokedWorkers.size,
    } : undefined;

    return {
      schemaVersion: 1,
      pid: process.pid,
      hostname: os.hostname(),
      startedAt,
      updatedAt: this.now().toISOString(),
      state,
      host: config.host,
      port: config.port,
      protocol: config.protocol,
      tokenFile: config.tokenFile,
      queueFile: this.queue.filePath,
      leaseMs: config.leaseMs,
      heartbeatMs: config.heartbeatMs,
      ...(tlsState ? { tls: tlsState } : {}),
      ...(lastError ? { lastError } : {}),
    };
  }

  private persistState(state: DaemonState): void {
    writeJsonAtomic(daemonStatePath(this.stateDir), state, 0o600);
  }

  private releaseDaemonLock(): void {
    const nonce = this.lockNonce;
    this.lockNonce = undefined;
    if (!nonce) return;
    const lockPath = daemonLockPath(this.stateDir);
    try {
      const holder = JSON.parse(readFileSync(lockPath, "utf-8")) as { nonce?: unknown };
      if (holder.nonce === nonce) rmSync(lockPath, { force: true });
    } catch {
      // Cleanup is best effort; a later start can use --recover after inspecting state.
    }
  }

  private authorized(req: http.IncomingMessage): boolean {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) return false;
    return sameToken(header.slice("Bearer ".length), this.token);
  }

  private registeredWorker(workerId: string): RegisteredWorker {
    const worker = this.workers.get(workerId);
    if (!worker) throw new Error("Worker is not registered");
    return worker;
  }

  private touchWorker(workerId: string, activeJobId?: string): RegisteredWorker {
    const current = this.registeredWorker(workerId);
    const next: RegisteredWorker = {
      ...current,
      lastSeenAt: this.now().toISOString(),
      ...(activeJobId !== undefined ? { activeJobId } : {}),
    };
    this.workers.set(workerId, next);
    return next;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy());
    const protocol = this.state?.protocol ?? "http";
    const url = new URL(req.url ?? "/", `${protocol}://${req.headers.host ?? "localhost"}`);
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, protocolVersion: JOB_PROTOCOL_VERSION });
      return;
    }

    const identity = extractClientIdentity(req);
    if (identity.fingerprint256 && this.revokedFingerprints.has(identity.fingerprint256)) {
      sendJson(res, 403, { error: "Client certificate has been revoked" });
      return;
    }
    if (this.options.tlsAllowedFingerprints && this.options.tlsAllowedFingerprints.length > 0) {
      if (!identity.fingerprint256 || !this.options.tlsAllowedFingerprints.includes(identity.fingerprint256)) {
        sendJson(res, 403, { error: "Client certificate fingerprint is not authorized" });
        return;
      }
    }
    if (this.options.tlsAllowedIdentities && this.options.tlsAllowedIdentities.length > 0) {
      if (!identity.subjectCn || !this.options.tlsAllowedIdentities.includes(identity.subjectCn)) {
        sendJson(res, 403, { error: `Client certificate identity '${identity.subjectCn ?? "unknown"}' is not authorized` });
        return;
      }
    }

    if (req.method === "GET" && url.pathname === "/metrics") {
      const isLoopback = isLoopbackAddress(req.socket.remoteAddress);
      if (!isLoopback) {
        if (!this.authorized(req)) {
          sendJson(res, 401, { error: "Unauthorized" });
          return;
        }
      } else {
        if (req.headers.authorization && !this.authorized(req)) {
          sendJson(res, 401, { error: "Unauthorized" });
          return;
        }
      }
      this.updateWorkerGauges();
      const body = defaultMetricsRegistry.scrape();
      res.writeHead(200, {
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(body);
      return;
    }

    if (!this.authorized(req)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    const traceparent = typeof req.headers.traceparent === "string" ? req.headers.traceparent : undefined;
    const parentContext = parseTraceParent(traceparent) ?? undefined;
    const tracer = getTracer("bisectpilot.daemon");

    await tracer.withSpan(
      `daemon.http.${req.method ?? "GET"}`,
      async (span) => {
        span.setAttribute("http.method", req.method ?? "GET");
        span.setAttribute("http.route", url.pathname);

        try {
          if (req.method === "GET" && url.pathname === "/v1/status") {
            sendJson(res, 200, this.status());
            return;
          }
          if (req.method === "GET" && url.pathname.startsWith("/v1/jobs/")) {
            const id = decodeURIComponent(url.pathname.slice("/v1/jobs/".length));
            const job = this.queue.get(id);
            if (!job) {
              sendJson(res, 404, { error: "Job not found" });
              return;
            }
            sendJson(res, 200, { job: summarizeJob(job), result: job.result ?? null });
            return;
          }

          const body = await readJsonBody(req);
          if (req.method === "POST" && url.pathname === "/v1/admin/revoke") {
            if (!isLoopbackAddress(req.socket.remoteAddress)) {
              sendJson(res, 403, { error: "Revocation administration is allowed only from loopback" });
              return;
            }
            if (!isRecord(body)) throw new Error("Revocation request must be an object");
            if (typeof body.fingerprint === "string") {
              this.revokeClientCertificate(body.fingerprint, typeof body.reason === "string" ? body.reason : undefined);
            }
            if (typeof body.workerId === "string") {
              this.revokeWorker(body.workerId, typeof body.reason === "string" ? body.reason : undefined);
            }
            sendJson(res, 200, {
              ok: true,
              revokedFingerprintsCount: this.revokedFingerprints.size,
              revokedWorkersCount: this.revokedWorkers.size,
            });
            return;
          }
          if (req.method === "POST" && url.pathname === "/v1/jobs") {
            if (!isRecord(body)) throw new Error("Job request must be an object");
            const checked = validateAsyncJobPayload(body.payload);
            if (!checked.ok) throw new Error(checked.error);
            const job = this.queue.create(checked.payload, this.now());
            sendJson(res, 201, { job: summarizeJob(job) });
            return;
          }
          if (req.method === "POST" && url.pathname === "/v1/workers/register") {
            const checked = parseWorkerCapabilities(body);
            if (!checked.ok) throw new Error(checked.error);
            if (this.revokedWorkers.has(checked.capabilities.workerId)) {
              sendJson(res, 403, { error: `Worker '${checked.capabilities.workerId}' has been revoked` });
              return;
            }
            if (identity.subjectCn && identity.subjectCn !== checked.capabilities.workerId) {
              sendJson(res, 403, { error: `Client certificate CN '${identity.subjectCn}' does not match workerId '${checked.capabilities.workerId}'` });
              return;
            }
            const current = this.workers.get(checked.capabilities.workerId);
            const now = this.now().toISOString();
            const worker: RegisteredWorker = {
              capabilities: checked.capabilities,
              registeredAt: current?.registeredAt ?? now,
              lastSeenAt: now,
              ...(current?.activeJobId ? { activeJobId: current.activeJobId } : {}),
              ...(identity.fingerprint256 ? { clientCertFingerprint: identity.fingerprint256 } : {}),
              ...(identity.subjectCn ? { clientCertSubjectCn: identity.subjectCn } : {}),
            };
            this.workers.set(worker.capabilities.workerId, worker);
            this.updateWorkerGauges();
            sendJson(res, 200, { registered: true, workerId: worker.capabilities.workerId, leaseMs: this.state?.leaseMs ?? DEFAULT_LEASE_MS });
            return;
          }
          if (req.method === "POST" && url.pathname === "/v1/workers/deregister") {
            if (!isRecord(body) || typeof body.workerId !== "string") throw new Error("workerId is required");
            this.workers.delete(body.workerId);
            this.updateWorkerGauges();
            sendJson(res, 200, { deregistered: true });
            return;
          }
          if (req.method === "POST" && url.pathname === "/v1/jobs/poll") {
            const checked = parseWorkerCapabilities(body);
            if (!checked.ok) throw new Error(checked.error);
            if (this.revokedWorkers.has(checked.capabilities.workerId)) {
              sendJson(res, 403, { error: `Worker '${checked.capabilities.workerId}' has been revoked` });
              return;
            }
            if (identity.subjectCn && identity.subjectCn !== checked.capabilities.workerId) {
              sendJson(res, 403, { error: `Client certificate CN '${identity.subjectCn}' does not match workerId '${checked.capabilities.workerId}'` });
              return;
            }
            const worker = this.registeredWorker(checked.capabilities.workerId);
            const activeJobs = this.queue.list().filter(
              (j) => j.assignedWorkerId === worker.capabilities.workerId && (j.state === "leased" || j.state === "running" || j.state === "cancel_requested")
            );
            const maxJobs = checked.capabilities.maxConcurrentJobs ?? 1;
            if (activeJobs.length >= maxJobs) {
              this.touchWorker(worker.capabilities.workerId);
              const cancelRequested = activeJobs.some((j) => j.state === "cancel_requested");
              sendJson(res, 200, { job: null, cancelRequested });
              return;
            }
            const job = this.queue.claimNext(checked.capabilities, this.state?.leaseMs ?? DEFAULT_LEASE_MS, this.now());
            if (!job) {
              this.touchWorker(worker.capabilities.workerId);
              this.updateWorkerGauges();
              sendJson(res, 200, { job: null, cancelRequested: false });
              return;
            }
            this.touchWorker(worker.capabilities.workerId, job.id);
            this.updateWorkerGauges();
            sendJson(res, 200, { job, cancelRequested: false });
            return;
          }

          const jobAction = /^\/v1\/jobs\/([^/]+)\/(heartbeat|result|cancel|recover)$/.exec(url.pathname);
          if (req.method === "POST" && jobAction) {
            const jobId = decodeURIComponent(jobAction[1]!);
            const action = jobAction[2]!;
            if (action === "cancel") {
              const job = this.queue.requestCancel(jobId, isRecord(body) && typeof body.reason === "string" ? body.reason.slice(0, 500) : undefined, this.now());
              sendJson(res, 200, { job: summarizeJob(job) });
              return;
            }
            if (action === "recover") {
              const job = this.queue.recover(jobId, isRecord(body) && typeof body.reason === "string" ? body.reason.slice(0, 500) : undefined, this.now());
              sendJson(res, 200, { job: summarizeJob(job) });
              return;
            }
            if (!isRecord(body) || typeof body.workerId !== "string" || typeof body.attempt !== "number" || !Number.isInteger(body.attempt)) {
              throw new Error("workerId and integer attempt are required");
            }
            if (this.revokedWorkers.has(body.workerId)) {
              sendJson(res, 403, { error: `Worker '${body.workerId}' has been revoked` });
              return;
            }
            if (identity.subjectCn && identity.subjectCn !== body.workerId) {
              sendJson(res, 403, { error: `Client certificate CN '${identity.subjectCn}' does not match workerId '${body.workerId}'` });
              return;
            }
            const worker = this.registeredWorker(body.workerId);
            if (action === "heartbeat") {
              const fencingToken = typeof body.fencingToken === "number" ? body.fencingToken : undefined;
              const heartbeat = this.queue.heartbeat(jobId, body.workerId, body.attempt, this.state?.leaseMs ?? DEFAULT_LEASE_MS, this.now(), fencingToken);
              this.touchWorker(worker.capabilities.workerId, jobId);
              sendJson(res, 200, { job: summarizeJob(heartbeat.job), cancelRequested: heartbeat.cancelRequested });
              return;
            }
            const current = this.queue.get(jobId);
            if (!current) throw new Error(`Job not found: ${jobId}`);
            const parsedResult = parseResultBody(body, current);
            if (!parsedResult.ok) throw new Error(parsedResult.error);
            const fencingToken = typeof body.fencingToken === "number" ? body.fencingToken : undefined;
            const submitted = this.queue.submitResult(jobId, body.workerId, body.attempt, parsedResult.result, this.now(), fencingToken);
            this.touchWorker(worker.capabilities.workerId, undefined);
            this.updateWorkerGauges();
            sendJson(res, 200, { job: summarizeJob(submitted.job), accepted: submitted.accepted, duplicate: submitted.duplicate });
            return;
          }
          if (req.method === "POST" && url.pathname === "/v1/shutdown") {
            if (!isLoopbackAddress(req.socket.remoteAddress)) {
              sendJson(res, 403, { error: "Shutdown is allowed only from loopback" });
              return;
            }
            sendJson(res, 202, { accepted: true });
            setImmediate(() => void this.stop("Shutdown requested through local control endpoint"));
            return;
          }
          sendJson(res, 404, { error: "Not found" });
        } catch (error: unknown) {
          const message = (error as Error).message;
          const status = message.includes("not found") ? 404 : message.includes("Unauthorized") ? 401 : 400;
          sendJson(res, status, { error: message.slice(0, 500) });
        }
      },
      parentContext ? { parent: parentContext } : undefined
    );
  }
}


function parseResultBody(value: Record<string, unknown>, job: JobRecord):
  | { ok: true; result: Omit<JobResult, "attempt" | "finishedAt"> }
  | { ok: false; error: string } {
  if (
    typeof value.sessionId !== "string" ||
    value.sessionId !== job.sessionId ||
    (value.status !== "succeeded" && value.status !== "failed" && value.status !== "cancelled")
  ) {
    return { ok: false, error: "Invalid worker result identity or status" };
  }
  if (value.detail !== undefined && (typeof value.detail !== "string" || value.detail.length > 8_192)) {
    return { ok: false, error: "Worker result detail is invalid or too large" };
  }
  if (value.fencingToken !== undefined && (!Number.isInteger(value.fencingToken) || (value.fencingToken as number) < 1)) {
    return { ok: false, error: "Worker fencing token is invalid" };
  }
  if (value.conclusion !== undefined && !isValidSessionConclusion(value.conclusion)) return { ok: false, error: "Worker conclusion shape is invalid" };
  if (value.sampleResult !== undefined) {
    if (
      !isRecord(value.sampleResult) ||
      (value.sampleResult.outcome !== "good" && value.sampleResult.outcome !== "bad" && value.sampleResult.outcome !== "skip" && value.sampleResult.outcome !== "inconclusive") ||
      (value.sampleResult.measurement !== undefined && typeof value.sampleResult.measurement !== "number") ||
      (value.sampleResult.durationMs !== undefined && typeof value.sampleResult.durationMs !== "number")
    ) {
      return { ok: false, error: "Worker sample result shape is invalid" };
    }
  }
  return {
    ok: true,
    result: {
      status: value.status,
      sessionId: value.sessionId,
      ...(typeof value.detail === "string" ? { detail: value.detail } : {}),
      ...(typeof value.fencingToken === "number" ? { fencingToken: value.fencingToken } : {}),
      ...(value.conclusion !== undefined ? { conclusion: value.conclusion as unknown as JobResult["conclusion"] } : {}),
      ...(value.sampleResult !== undefined ? { sampleResult: value.sampleResult as unknown as JobResult["sampleResult"] } : {}),
    },
  };
}
