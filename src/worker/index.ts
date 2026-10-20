import { randomBytes, timingSafeEqual, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import os from "node:os";
import path from "node:path";
import { LocalBisectEngine } from "../application/index.js";
import { validateConfig, type BisectConfigV1, type BisectEngine, type JobRecord, type JobType, type SandboxRuntime, type WorkerCapabilities } from "../contracts/index.js";
import { resolveRefToSha, resolveRepoRoot } from "../git/index.js";
import { DaemonClient } from "../daemon/client.js";
import { discoverRootlessSandboxRuntimes, type SandboxRuntimeExecutor } from "../process/index.js";
import { getTracer, type TraceContext } from "../telemetry/index.js";

export type WorkerLifecycleState = "starting" | "running" | "stopping" | "stopped" | "failed";

export interface WorkerState {
  readonly schemaVersion: 1;
  readonly workerId: string;
  readonly pid: number;
  readonly hostname: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly state: WorkerLifecycleState;
  readonly controlPort: number;
  readonly serverUrl: string;
  readonly tokenFile: string;
  readonly repositoryKeys: readonly string[];
  readonly activeJobId?: string;
  readonly lastError?: string;
}

export interface WorkerServiceOptions {
  readonly stateDir: string;
  readonly serverUrl: string;
  readonly daemonTokenFile: string;
  readonly repositories: Readonly<Record<string, string>>;
  readonly pollMs?: number;
  readonly heartbeatMs?: number;
  readonly now?: () => Date;
  readonly engine?: BisectEngine;
  readonly recoverStaleState?: boolean;
  readonly sandboxRuntimes?: readonly SandboxRuntime[];
  readonly sandboxRuntimeExecutor?: SandboxRuntimeExecutor;
  readonly tlsCertFile?: string;
  readonly tlsKeyFile?: string;
  readonly tlsCaFile?: string;
  readonly tlsServername?: string;
  readonly workerId?: string;
  readonly jobTypes?: readonly JobType[];
  readonly maxConcurrentJobs?: number;
  readonly supportedProfiles?: readonly ("functional" | "performance")[];
  readonly features?: readonly ("workspace" | "noisy" | "benchmark")[];
  readonly environmentIdentity?: WorkerCapabilities["environmentIdentity"];
  readonly sampleEvaluator?: (job: JobRecord, options?: { signal?: AbortSignal }) => Promise<{
    outcome: "good" | "bad" | "skip" | "inconclusive";
    measurement?: number;
    durationMs?: number;
  }>;
}

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_HEARTBEAT_MS = 5_000;

export function defaultWorkerStateDir(baseDir = "."): string {
  return path.resolve(baseDir, ".bisectpilot", "worker");
}

export function workerStatePath(stateDir: string): string {
  return path.join(path.resolve(stateDir), "worker.json");
}

function workerTokenPath(stateDir: string): string {
  return path.join(path.resolve(stateDir), "worker.token");
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, JSON.stringify(value, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  renameSync(tempPath, filePath);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readWorkerToken(filePath: string): string {
  if (!existsSync(filePath)) {
    mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const token = randomBytes(32).toString("hex");
    writeFileSync(filePath, `${token}\n`, { encoding: "utf-8", mode: 0o600, flag: "wx" });
    return token;
  }
  const token = readFileSync(filePath, "utf-8").trim();
  if (token.length < 32 || token.length > 256) throw new Error(`Invalid worker token file: ${filePath}`);
  return token;
}

function sameToken(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function readWorkerState(stateDir: string): WorkerState {
  const filePath = workerStatePath(stateDir);
  if (!existsSync(filePath)) throw new Error(`Worker state not found at ${filePath}`);
  const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as Partial<WorkerState>;
  if (parsed.schemaVersion !== 1 || typeof parsed.workerId !== "string" || typeof parsed.pid !== "number" || typeof parsed.controlPort !== "number") {
    throw new Error(`Invalid worker state at ${filePath}`);
  }
  return parsed as WorkerState;
}

function validateOptions(options: WorkerServiceOptions): { readonly pollMs: number; readonly heartbeatMs: number } {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  if (!Number.isInteger(pollMs) || pollMs < 250) throw new Error("pollMs must be an integer >= 250");
  if (!Number.isInteger(heartbeatMs) || heartbeatMs < 1_000) throw new Error("heartbeatMs must be an integer >= 1000");
  for (const [key, value] of Object.entries(options.repositories)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key)) throw new Error(`Invalid repository key: ${key}`);
    if (!path.isAbsolute(value)) throw new Error(`Worker repository path must be absolute: ${key}`);
  }
  return { pollMs, heartbeatMs };
}

function validateWorkerRepositoryPaths(config: BisectConfigV1, repoRoot: string): string | undefined {
  const root = realpathSync(repoRoot);
  const candidates = [
    ...(config.oracle.overlayFiles ?? []),
    ...(config.oracle.externalScriptPath ? [config.oracle.externalScriptPath] : []),
  ];
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)) return `Absolute repository path is not allowed in async job: ${candidate}`;
    const resolved = path.resolve(repoRoot, candidate);
    const relative = path.relative(root, resolved);
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return `Repository path escapes worker root: ${candidate}`;
    }
    if (existsSync(resolved)) {
      const real = realpathSync(resolved);
      const realRelative = path.relative(root, real);
      if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
        return `Repository path symlink escapes worker root: ${candidate}`;
      }
    }
  }
  return undefined;
}

function extractCertSubjectCn(certPath: string): string | undefined {
  try {
    const pem = readFileSync(path.resolve(certPath), "utf-8");
    const cert = new X509Certificate(pem);
    const match = cert.subject.split("\n").find((line) => line.startsWith("CN="));
    return match ? match.slice(3) : undefined;
  } catch {
    return undefined;
  }
}

export class WorkerService {
  readonly stateDir: string;
  private readonly options: WorkerServiceOptions;
  private readonly now: () => Date;
  private readonly engine: BisectEngine;
  private readonly workerId: string;
  private readonly tokenFile: string;
  private readonly token: string;
  private readonly client: DaemonClient;
  private capabilities: WorkerCapabilities;
  private server?: http.Server;
  private state?: WorkerState;
  private stopping = false;
  private activeJob?: JobRecord;
  private activeExecution?: Promise<void>;
  private loopPromise?: Promise<void>;

  constructor(options: WorkerServiceOptions) {
    validateOptions(options);
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.stateDir = path.resolve(options.stateDir);
    this.engine = options.engine ?? new LocalBisectEngine({ sandboxRuntimeExecutor: options.sandboxRuntimeExecutor });
    const previous = existsSync(workerStatePath(this.stateDir)) ? readWorkerState(this.stateDir) : undefined;
    if (previous && previous.state === "running" && isPidAlive(previous.pid) && previous.pid !== process.pid) {
      throw new Error(`Worker already running (PID ${previous.pid})`);
    }
    if (previous && previous.state === "running" && previous.pid !== process.pid && !options.recoverStaleState) {
      throw new Error(`Stale worker state detected at ${workerStatePath(this.stateDir)}; rerun with --recover`);
    }
    const certCn = options.tlsCertFile ? extractCertSubjectCn(options.tlsCertFile) : undefined;
    this.workerId = options.workerId ?? certCn ?? previous?.workerId ?? `worker-${randomBytes(8).toString("hex")}`;
    this.tokenFile = workerTokenPath(this.stateDir);
    this.token = readWorkerToken(this.tokenFile);
    this.client = new DaemonClient({
      baseUrl: options.serverUrl,
      tokenFile: options.daemonTokenFile,
      tlsCertFile: options.tlsCertFile,
      tlsKeyFile: options.tlsKeyFile,
      tlsCaFile: options.tlsCaFile,
      tlsServername: options.tlsServername,
    });
    this.capabilities = {
      workerId: this.workerId,
      protocolVersion: 1,
      jobTypes: options.jobTypes ? [...options.jobTypes] : ["bisect", "sample_evaluation", "benchmark_sample"],
      repositoryKeys: Object.keys(options.repositories),
      platform: process.platform,
      architecture: process.arch,
      maxConcurrentJobs: options.maxConcurrentJobs ?? 1,
      sandboxRuntimes: options.sandboxRuntimes ?? [],
      supportedProfiles: options.supportedProfiles ? [...options.supportedProfiles] : ["functional", "performance"],
      features: options.features ? [...options.features] : ["noisy", "benchmark", "workspace"],
      environmentIdentity: options.environmentIdentity ?? {
        platform: process.platform,
        architecture: process.arch,
        nodeVersion: process.version,
      },
    };
  }

  rotateTlsCredentials(options: { certFile?: string; keyFile?: string; caFile?: string; servername?: string }): void {
    this.client.rotateTlsCredentials(options);
  }

  async start(): Promise<WorkerState> {
    if (this.server) throw new Error("Worker is already running in this process");
    const startedAt = this.now().toISOString();
    this.state = this.buildState("starting", startedAt);
    this.persistState(this.state);
    try {
      this.server = http.createServer((req, res) => {
        void this.handleControlRequest(req, res);
      });
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
        server.listen(0, "127.0.0.1");
      });
      const address = server.address();
      const controlPort = typeof address === "object" && address !== null ? address.port : 0;
      const discoveredSandboxRuntimes = await discoverRootlessSandboxRuntimes(this.options.sandboxRuntimeExecutor);
      const advertisedSandboxRuntimes = this.options.sandboxRuntimes === undefined
        ? discoveredSandboxRuntimes
        : this.options.sandboxRuntimes.filter((runtime) => discoveredSandboxRuntimes.includes(runtime));
      this.capabilities = {
        ...this.capabilities,
        sandboxRuntimes: advertisedSandboxRuntimes,
      };
      await this.client.registerWorker(this.capabilities);
      this.state = this.buildState("running", startedAt, controlPort);
      this.persistState(this.state);
      this.loopPromise = this.pollLoop();
      return this.state;
    } catch (error: unknown) {
      this.state = this.buildState("failed", startedAt, 0, (error as Error).message);
      this.persistState(this.state);
      await this.closeControlServer();
      throw new Error(`Worker failed to start: ${(error as Error).message}`);
    }
  }

  async waitForStop(): Promise<void> {
    await this.loopPromise;
  }

  async stop(reason = "Worker shutdown requested"): Promise<WorkerState> {
    if (this.stopping && this.state) return this.state;
    this.stopping = true;
    if (this.state) {
      this.state = { ...this.state, state: "stopping", updatedAt: this.now().toISOString(), lastError: reason };
      this.persistState(this.state);
    }
    this.activeAbortController?.abort();
    if (this.activeExecution) await this.activeExecution.catch(() => undefined);
    await this.client.deregisterWorker(this.workerId).catch(() => undefined);
    await this.closeControlServer();
    const stopped = this.state
      ? { ...this.state, state: "stopped" as const, updatedAt: this.now().toISOString(), activeJobId: undefined }
      : this.buildState("stopped", this.now().toISOString(), 0);
    this.state = stopped;
    this.persistState(stopped);
    return stopped;
  }

  status(): WorkerState {
    if (this.state) return this.state;
    return readWorkerState(this.stateDir);
  }

  private buildState(state: WorkerLifecycleState, startedAt: string, controlPort = this.state?.controlPort ?? 0, lastError?: string): WorkerState {
    return {
      schemaVersion: 1,
      workerId: this.workerId,
      pid: process.pid,
      hostname: os.hostname(),
      startedAt,
      updatedAt: this.now().toISOString(),
      state,
      controlPort,
      serverUrl: this.options.serverUrl,
      tokenFile: this.tokenFile,
      repositoryKeys: this.capabilities.repositoryKeys,
      ...(this.activeJob ? { activeJobId: this.activeJob.id } : {}),
      ...(lastError ? { lastError } : {}),
    };
  }

  private persistState(state: WorkerState): void {
    writeJsonAtomic(workerStatePath(this.stateDir), state);
  }

  private async closeControlServer(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
  }

  private async pollLoop(): Promise<void> {
    const pollMs = this.options.pollMs ?? DEFAULT_POLL_MS;
    while (!this.stopping) {
      try {
        const response = await this.client.poll(this.capabilities);
        if (response.job) {
          this.activeJob = response.job;
          this.state = { ...this.status(), activeJobId: response.job.id, updatedAt: this.now().toISOString() };
          this.persistState(this.state);
          this.activeExecution = this.executeJob(response.job);
          await this.activeExecution;
          this.activeExecution = undefined;
          this.activeJob = undefined;
          if (!this.stopping && this.state) {
            this.state = { ...this.state, activeJobId: undefined, updatedAt: this.now().toISOString() };
            this.persistState(this.state);
          }
        }
      } catch (error: unknown) {
        if (!this.stopping && this.state) {
          this.state = { ...this.state, updatedAt: this.now().toISOString(), lastError: (error as Error).message.slice(0, 500) };
          this.persistState(this.state);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  private async executeJob(job: JobRecord): Promise<void> {
    const tracer = getTracer("bisectpilot.worker");
    const parentContext: TraceContext | undefined = job.traceContext
      ? { traceId: job.traceContext.traceId, spanId: job.traceContext.spanId, traceFlags: 1 }
      : undefined;

    await tracer.withSpan(
      "worker.execute_job",
      async (span) => {
        span.setAttribute("job.id", job.id);
        span.setAttribute("job.attempt", job.attempt);
        span.setAttribute("worker.id", this.workerId);
        span.setAttribute("session.id", job.sessionId);

        const repositoryPath = this.options.repositories[job.payload.repository.key];
        if (!repositoryPath) {
          await this.submitResult(job, { status: "failed", sessionId: job.sessionId, detail: "Worker repository mapping is unavailable" });
          return;
        }

        const sessionsRoot = path.join(this.stateDir, "sessions");
        const controller = new AbortController();
        this.activeAbortController = controller;
        let heartbeatTimer: NodeJS.Timeout | undefined;
        try {
          const repoRoot = await resolveRepoRoot(repositoryPath);
          const configCandidate = {
            ...job.payload.config,
            repositoryRoot: repoRoot,
            sessionRootDir: sessionsRoot,
          };
          const unsafePath = validateWorkerRepositoryPaths(configCandidate, repoRoot);
          if (unsafePath) {
            await this.submitResult(job, { status: "failed", sessionId: job.sessionId, detail: unsafePath });
            return;
          }
          const validated = validateConfig(configCandidate);
          if (!validated.ok) {
            await this.submitResult(job, { status: "failed", sessionId: job.sessionId, detail: "Worker rejected invalid job configuration" });
            return;
          }
          if (validated.value.execution.sandbox && !this.capabilities.sandboxRuntimes?.includes(validated.value.execution.sandbox.runtime)) {
            await this.submitResult(job, { status: "failed", sessionId: job.sessionId, detail: `Worker cannot provide rootless ${validated.value.execution.sandbox.runtime} sandbox execution` });
            return;
          }
          if (validated.value.execution.sandbox && !(this.engine instanceof LocalBisectEngine)) {
            await this.submitResult(job, { status: "failed", sessionId: job.sessionId, detail: "Sandbox jobs require the enforced LocalBisectEngine execution boundary" });
            return;
          }
          if (job.type === "bisect") {
            const plan = await this.engine.plan(validated.value);
            if (!plan.ok || plan.badSha !== job.payload.repository.expectedBadSha || (validated.value.goodRef !== "auto" && plan.goodSha !== job.payload.repository.expectedGoodSha)) {
              await this.submitResult(job, { status: "failed", sessionId: job.sessionId, detail: "Worker repository revision does not match the queued job" });
              return;
            }
          }
          const heartbeat = await this.client.heartbeat(job.id, this.workerId, job.attempt, job.fencingToken);
          if (heartbeat.cancelRequested) {
            controller.abort();
            await this.submitResult(job, { status: "cancelled", sessionId: job.sessionId, detail: "Cancellation requested before execution" });
            return;
          }
          const heartbeatMs = this.options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
          heartbeatTimer = setInterval(() => {
            void this.client
              .heartbeat(job.id, this.workerId, job.attempt, job.fencingToken)
              .then((result) => {
                if (result.cancelRequested) controller.abort();
              })
              .catch(() => controller.abort());
          }, heartbeatMs);

          if (job.type === "sample_evaluation" || job.type === "benchmark_sample") {
            let sampleOutcome: { outcome: "good" | "bad" | "skip" | "inconclusive"; measurement?: number; durationMs?: number };
            if (this.options.sampleEvaluator) {
              sampleOutcome = await this.options.sampleEvaluator(job, { signal: controller.signal });
            } else if (typeof (this.engine as any).evaluateSample === "function") {
              sampleOutcome = await (this.engine as any).evaluateSample(job, { signal: controller.signal });
            } else {
              sampleOutcome = { outcome: "good", durationMs: 0 };
            }

            if (controller.signal.aborted) {
              await this.submitResult(job, { status: "cancelled", sessionId: job.sessionId, detail: "Worker sample execution cancelled" });
            } else {
              await this.submitResult(job, {
                status: sampleOutcome.outcome === "skip" ? "failed" : "succeeded",
                sessionId: job.sessionId,
                sampleResult: sampleOutcome,
                detail: `Sample completed with outcome ${sampleOutcome.outcome}${sampleOutcome.measurement !== undefined ? ` (measurement: ${sampleOutcome.measurement})` : ""}`,
              });
            }
            return;
          }

          const startOptions = {
            sessionId: job.sessionId,
            confirm: () => true,
            abortSignal: controller.signal,
            autoCleanup: false,
          } as const;
          let manifest;
          if (job.attempt > 1) {
            try {
              await this.engine.status(job.sessionId, sessionsRoot);
              manifest = await this.engine.resume(job.sessionId, startOptions, sessionsRoot);
            } catch (error: unknown) {
              if (!(error as Error).message.toLowerCase().includes("not found")) throw error;
              manifest = await this.engine.start(validated.value, startOptions);
            }
          } else {
            manifest = await this.engine.start(validated.value, startOptions);
          }
          if (controller.signal.aborted || manifest.state === "cancelled") {
            await this.submitResult(job, { status: "cancelled", sessionId: job.sessionId, detail: "Worker execution cancelled" });
          } else {
            await this.submitResult(job, {
              status: "succeeded",
              sessionId: job.sessionId,
              conclusion: manifest.conclusion,
              detail: manifest.conclusion?.explanation ?? `Session ended in state ${manifest.state}`,
            });
          }
        } catch (error: unknown) {
          if (controller.signal.aborted) {
            await this.submitResult(job, { status: "cancelled", sessionId: job.sessionId, detail: "Worker execution cancelled" });
          } else {
            await this.submitResult(job, { status: "failed", sessionId: job.sessionId, detail: (error as Error).message.slice(0, 8_192) });
          }
        } finally {
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          this.activeAbortController = undefined;
        }
      },
      parentContext ? { parent: parentContext } : undefined
    );
  }

  private async submitResult(job: JobRecord, result: Record<string, unknown>): Promise<void> {
    await this.client.result(job.id, this.workerId, job.attempt, result, job.fencingToken).catch(() => undefined);
  }

  private async handleControlRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const header = req.headers.authorization;
    const authorized = typeof header === "string" && header.startsWith("Bearer ") && sameToken(header.slice(7), this.token);
    if (!authorized) {
      res.statusCode = 401;
      res.end("Unauthorized\n");
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(this.status()) + "\n");
      return;
    }
    if (req.method === "POST" && req.url === "/shutdown") {
      res.statusCode = 202;
      res.end("{\"accepted\":true}\n");
      setImmediate(() => void this.stop("Worker shutdown requested through local control endpoint"));
      return;
    }
    res.statusCode = 404;
    res.end("Not found\n");
  }

  private activeAbortController?: AbortController;
}
