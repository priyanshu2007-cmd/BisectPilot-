import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  ALLOWED_JOB_TRANSITIONS,
  TERMINAL_JOB_STATES,
  isValidJobTransition,
  validateConfig,
  type BisectJobPayload,
  type JobQueueSummary,
  type JobRecord,
  type JobResult,
  type JobState,
  type JobTransitionRecord,
  type JobType,
  type QueueSnapshot,
  type SessionConclusion,
  type WorkerCapabilities,
} from "../contracts/index.js";
import { defaultMetrics, getActiveTraceContext } from "../telemetry/index.js";

export const JOB_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_JOB_LEASE_MS = 30_000;
export const MAX_QUEUE_JOBS = 10_000;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const MAX_REASON_LENGTH = 500;
const MAX_RESULT_DETAIL_LENGTH = 8_192;
const SESSION_OUTCOMES = new Set(["candidate_confirmed", "candidate_unconfirmed", "candidate_range", "inconclusive", "aborted"]);
const INCONCLUSIVE_REASONS = new Set(["skip_budget_exceeded", "oracle_flaky_at_endpoints", "endpoints_contradict", "toolchain_mismatch_majority"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJobState(value: unknown): value is JobState {
  return typeof value === "string" && value in ALLOWED_JOB_TRANSITIONS;
}

function invalid(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

export function validateAsyncJobPayload(value: unknown):
  | { ok: true; payload: BisectJobPayload }
  | { ok: false; error: string } {
  if (!isRecord(value)) return invalid("Job payload must be an object");
  const configResult = validateConfig(value.config);
  if (!configResult.ok) {
    return invalid(`Invalid job config: ${configResult.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
  }
  if (configResult.value.execution.envOverrides && Object.keys(configResult.value.execution.envOverrides).length > 0) {
    return invalid("Async jobs cannot persist execution.envOverrides; use worker-local environment configuration");
  }
  if (configResult.value.execution.interactivePrompt) {
    return invalid("Async jobs cannot use interactivePrompt; workers run headless");
  }
  if (configResult.value.execution.confirmBeforeExecutingCode) {
    return invalid("Async jobs require explicit caller consent before enqueue; set confirmBeforeExecutingCode false only after consent");
  }
  const overlayFiles = configResult.value.oracle.overlayFiles ?? [];
  for (const file of overlayFiles) {
    if (path.isAbsolute(file) || path.normalize(file).startsWith(`..${path.sep}`) || path.normalize(file) === "..") {
      return invalid("Async overlay files must stay inside the pre-provisioned repository");
    }
  }
  if (configResult.value.oracle.externalScriptPath) {
    const externalPath = configResult.value.oracle.externalScriptPath;
    if (path.isAbsolute(externalPath) || path.normalize(externalPath).startsWith(`..${path.sep}`) || path.normalize(externalPath) === "..") {
      return invalid("Async external oracle paths must stay inside the pre-provisioned repository");
    }
  }

  const repository = value.repository;
  if (!isRecord(repository) || repository.strategy !== "preprovisioned") {
    return invalid('Job repository.strategy must be "preprovisioned"');
  }
  if (typeof repository.key !== "string" || !ID_PATTERN.test(repository.key)) {
    return invalid("Job repository.key must be a short stable identifier");
  }
  if (
    typeof repository.expectedGoodSha !== "string" ||
    !SHA_PATTERN.test(repository.expectedGoodSha) ||
    typeof repository.expectedBadSha !== "string" ||
    !SHA_PATTERN.test(repository.expectedBadSha)
  ) {
    return invalid("Job repository expected SHAs must be 40-character commit IDs");
  }

  return {
    ok: true,
    payload: {
      config: configResult.value,
      repository: {
        strategy: "preprovisioned",
        key: repository.key,
        expectedGoodSha: repository.expectedGoodSha.toLowerCase(),
        expectedBadSha: repository.expectedBadSha.toLowerCase(),
      },
    },
  };
}

export interface CreateJobOptions {
  readonly type?: JobType;
  readonly sampleMetadata?: JobRecord["sampleMetadata"];
  readonly requiredCapabilities?: {
    readonly jobTypes?: readonly JobType[];
    readonly profile?: "functional" | "performance";
    readonly features?: readonly ("workspace" | "noisy" | "benchmark")[];
    readonly environmentIdentity?: {
      readonly platform: string;
      readonly architecture: string;
      readonly nodeVersion?: string;
    };
  };
}

export function createJob(
  payload: BisectJobPayload,
  now = new Date(),
  traceContext?: { readonly traceId: string; readonly spanId: string },
  options?: CreateJobOptions
): JobRecord {
  const checked = validateAsyncJobPayload(payload);
  if (!checked.ok) throw new Error(checked.error);
  const id = `job-${randomUUID()}`;
  const timestamp = now.toISOString();
  const ctx = traceContext ?? getActiveTraceContext();
  const jobType = options?.type ?? "bisect";
  return {
    schemaVersion: 1,
    id,
    sessionId: `bp-${id.slice(4, 16)}`,
    type: jobType,
    protocolVersion: JOB_PROTOCOL_VERSION,
    state: "queued",
    fencingToken: 1,
    requiredCapabilities: {
      jobTypes: options?.requiredCapabilities?.jobTypes ?? [jobType],
      repositoryKey: checked.payload.repository.key,
      ...(checked.payload.config.execution.sandbox
        ? { sandboxRuntime: checked.payload.config.execution.sandbox.runtime }
        : {}),
      ...(options?.requiredCapabilities?.profile ? { profile: options.requiredCapabilities.profile } : {}),
      ...(options?.requiredCapabilities?.features ? { features: options.requiredCapabilities.features } : {}),
      ...(options?.requiredCapabilities?.environmentIdentity ? { environmentIdentity: options.requiredCapabilities.environmentIdentity } : {}),
    },
    payload: checked.payload,
    ...(options?.sampleMetadata ? { sampleMetadata: options.sampleMetadata } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
    attempt: 0,
    transitions: [],
    ...(ctx ? { traceContext: { traceId: ctx.traceId, spanId: ctx.spanId } } : {}),
  };
}

export function transitionJob(
  job: JobRecord,
  to: JobState,
  reason: string,
  now = new Date(),
  workerId?: string
): JobRecord {
  if (!isValidJobTransition(job.state, to)) {
    throw new Error(`Illegal job state transition: ${job.state} -> ${to}`);
  }
  const safeReason = reason.slice(0, MAX_REASON_LENGTH);
  const transition: JobTransitionRecord = {
    at: now.toISOString(),
    from: job.state,
    to,
    reason: safeReason,
    attempt: job.attempt,
    ...(workerId ? { workerId } : {}),
  };
  return {
    ...job,
    state: to,
    updatedAt: now.toISOString(),
    transitions: [...job.transitions, transition],
  };
}

function validateTransition(value: unknown): value is JobTransitionRecord {
  if (!isRecord(value)) return false;
  const attempt = typeof value.attempt === "number" ? value.attempt : -1;
  return (
    typeof value.at === "string" &&
    isJobState(value.from) &&
    isJobState(value.to) &&
    typeof value.reason === "string" &&
    value.reason.length <= MAX_REASON_LENGTH &&
    Number.isInteger(attempt) &&
    attempt >= 0 &&
    (value.workerId === undefined || typeof value.workerId === "string")
  );
}

export function isValidSessionConclusion(value: unknown): value is SessionConclusion {
  if (
    !isRecord(value) ||
    !SESSION_OUTCOMES.has(String(value.outcome)) ||
    typeof value.explanation !== "string" ||
    value.explanation.length > MAX_RESULT_DETAIL_LENGTH ||
    !Array.isArray(value.skippedShas) ||
    !value.skippedShas.every((sha) => typeof sha === "string" && SHA_PATTERN.test(sha))
  ) {
    return false;
  }
  if (value.candidateSha !== undefined && (typeof value.candidateSha !== "string" || !SHA_PATTERN.test(value.candidateSha))) return false;
  if (value.parentSha !== undefined && (typeof value.parentSha !== "string" || !SHA_PATTERN.test(value.parentSha))) return false;
  if (
    value.candidateRangeShas !== undefined &&
    (!Array.isArray(value.candidateRangeShas) || !value.candidateRangeShas.every((sha) => typeof sha === "string" && SHA_PATTERN.test(sha)))
  ) return false;
  if (value.inconclusiveReason !== undefined && (typeof value.inconclusiveReason !== "string" || !INCONCLUSIVE_REASONS.has(value.inconclusiveReason))) return false;
  return true;
}

const VALID_JOB_TYPES: ReadonlySet<string> = new Set(["bisect", "sample_evaluation", "benchmark_sample"]);

export function validateJobRecord(value: unknown): value is JobRecord {
  if (!isRecord(value)) return false;
  const attempt = typeof value.attempt === "number" ? value.attempt : -1;
  if (
    value.schemaVersion !== 1 ||
    typeof value.id !== "string" ||
    !ID_PATTERN.test(value.id) ||
    typeof value.sessionId !== "string" ||
    typeof value.type !== "string" ||
    !VALID_JOB_TYPES.has(value.type) ||
    value.protocolVersion !== JOB_PROTOCOL_VERSION ||
    !isJobState(value.state) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    !Number.isInteger(attempt) ||
    attempt < 0 ||
    (value.fencingToken !== undefined && (!Number.isInteger(value.fencingToken) || (value.fencingToken as number) < 1)) ||
    !Array.isArray(value.transitions) ||
    !value.transitions.every(validateTransition)
  ) {
    return false;
  }
  let state: JobState = "queued";
  for (const transition of value.transitions) {
    if (transition.from !== state || !isValidJobTransition(transition.from, transition.to)) return false;
    state = transition.to;
  }
  if (state !== value.state) return false;
  const payload = validateAsyncJobPayload(value.payload);
  if (!payload.ok || !isRecord(value.requiredCapabilities)) return false;
  if (
    !Array.isArray(value.requiredCapabilities.jobTypes) ||
    !value.requiredCapabilities.jobTypes.every((item) => typeof item === "string" && VALID_JOB_TYPES.has(item)) ||
    typeof value.requiredCapabilities.repositoryKey !== "string" ||
    !ID_PATTERN.test(value.requiredCapabilities.repositoryKey)
  ) {
    return false;
  }
  if (value.requiredCapabilities.sandboxRuntime !== undefined && value.requiredCapabilities.sandboxRuntime !== "docker" && value.requiredCapabilities.sandboxRuntime !== "podman") return false;
  if (value.requiredCapabilities.sandboxRuntime !== payload.payload.config.execution.sandbox?.runtime) return false;
  if (value.requiredCapabilities.repositoryKey !== payload.payload.repository.key) return false;
  if (value.assignedWorkerId !== undefined && typeof value.assignedWorkerId !== "string") return false;
  if (value.leaseExpiresAt !== undefined && typeof value.leaseExpiresAt !== "string") return false;
  if (value.lastHeartbeatAt !== undefined && typeof value.lastHeartbeatAt !== "string") return false;
  if (value.startedAt !== undefined && typeof value.startedAt !== "string") return false;
  if (value.cancelRequestedAt !== undefined && typeof value.cancelRequestedAt !== "string") return false;
  if (value.recoveryReason !== undefined && typeof value.recoveryReason !== "string") return false;
  if (value.result !== undefined && !validateJobResult(value.result, value.sessionId, attempt)) return false;
  return true;
}

function validateJobResult(value: unknown, sessionId: string, attempt: number): value is JobResult {
  if (!isRecord(value)) return false;
  const resultAttempt = typeof value.attempt === "number" ? value.attempt : -1;
  return (
    Number.isInteger(resultAttempt) &&
    resultAttempt >= 0 &&
    resultAttempt <= attempt &&
    (value.fencingToken === undefined || (Number.isInteger(value.fencingToken) && (value.fencingToken as number) >= 1)) &&
    (value.status === "succeeded" || value.status === "failed" || value.status === "cancelled") &&
    value.sessionId === sessionId &&
    typeof value.finishedAt === "string" &&
    (value.detail === undefined || (typeof value.detail === "string" && value.detail.length <= MAX_RESULT_DETAIL_LENGTH)) &&
    (value.conclusion === undefined || isValidSessionConclusion(value.conclusion)) &&
    (value.sampleResult === undefined || (
      isRecord(value.sampleResult) &&
      (value.sampleResult.outcome === "good" || value.sampleResult.outcome === "bad" || value.sampleResult.outcome === "skip" || value.sampleResult.outcome === "inconclusive") &&
      (value.sampleResult.measurement === undefined || typeof value.sampleResult.measurement === "number") &&
      (value.sampleResult.durationMs === undefined || typeof value.sampleResult.durationMs === "number")
    ))
  );
}

function emptySnapshot(): QueueSnapshot {
  return { schemaVersion: 1, updatedAt: new Date(0).toISOString(), jobs: [] };
}

export function isWorkerEligible(
  worker: WorkerCapabilities,
  required: JobRecord["requiredCapabilities"],
  jobType: JobType = "bisect"
): boolean {
  if (!worker.jobTypes.includes(jobType)) return false;
  if (!worker.repositoryKeys.includes(required.repositoryKey)) return false;
  if (required.sandboxRuntime !== undefined && (!worker.sandboxRuntimes || !worker.sandboxRuntimes.includes(required.sandboxRuntime))) {
    return false;
  }
  if (required.profile !== undefined && (!worker.supportedProfiles || !worker.supportedProfiles.includes(required.profile))) {
    return false;
  }
  if (required.features !== undefined && (!worker.features || !required.features.every((f) => worker.features?.includes(f)))) {
    return false;
  }
  if (required.environmentIdentity !== undefined) {
    if (!worker.environmentIdentity) return false;
    if (worker.environmentIdentity.platform !== required.environmentIdentity.platform) return false;
    if (worker.environmentIdentity.architecture !== required.environmentIdentity.architecture) return false;
    if (required.environmentIdentity.nodeVersion !== undefined && worker.environmentIdentity.nodeVersion !== required.environmentIdentity.nodeVersion) {
      return false;
    }
  }
  return true;
}

export class AtomicJobStore {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
  }

  load(): QueueSnapshot {
    if (!existsSync(this.filePath)) return emptySnapshot();
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf-8"));
    } catch {
      throw new Error(`Corrupt job queue at ${this.filePath}`);
    }
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || typeof parsed.updatedAt !== "string" || !Array.isArray(parsed.jobs)) {
      throw new Error(`Invalid job queue schema at ${this.filePath}`);
    }
    if (parsed.jobs.length > MAX_QUEUE_JOBS || !parsed.jobs.every(validateJobRecord)) {
      throw new Error(`Invalid or oversized job queue at ${this.filePath}`);
    }
    return parsed as unknown as QueueSnapshot;
  }

  save(snapshot: QueueSnapshot): void {
    if (snapshot.jobs.length > MAX_QUEUE_JOBS) throw new Error(`Job queue exceeds ${MAX_QUEUE_JOBS} jobs`);
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tempPath, JSON.stringify(snapshot, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
    renameSync(tempPath, this.filePath);
  }

  private updateGauges(jobs: readonly JobRecord[]): void {
    defaultMetrics.queueDepth.set(jobs.filter((j) => j.state === "queued" || j.state === "retry_pending").length);
    defaultMetrics.activeJobs.set(jobs.filter((j) => j.state === "leased" || j.state === "running").length);
    defaultMetrics.activeLeases.set(jobs.filter((j) => Boolean(j.leaseExpiresAt) && !TERMINAL_JOB_STATES.has(j.state)).length);
  }

  create(
    payload: BisectJobPayload,
    now = new Date(),
    traceContext?: { readonly traceId: string; readonly spanId: string },
    options?: CreateJobOptions
  ): JobRecord {
    const job = createJob(payload, now, traceContext, options);
    const snapshot = this.load();
    const next = { ...snapshot, updatedAt: now.toISOString(), jobs: [...snapshot.jobs, job] };
    this.save(next);
    defaultMetrics.jobsTotal.inc(1, { state: "queued" });
    if (job.sampleMetadata) {
      defaultMetrics.samplesTotal.inc(1, { type: job.sampleMetadata.kind, status: "scheduled" });
    }
    this.updateGauges(next.jobs);
    return job;
  }

  get(id: string): JobRecord | undefined {
    return this.load().jobs.find((job) => job.id === id);
  }

  list(): readonly JobRecord[] {
    return this.load().jobs;
  }

  summary(): JobQueueSummary {
    const jobs = this.load().jobs;
    const count = (state: JobState) => jobs.filter((job) => job.state === state).length;
    return {
      total: jobs.length,
      queued: count("queued"),
      leased: count("leased"),
      running: count("running"),
      retryPending: count("retry_pending"),
      needsRecovery: count("needs_recovery"),
      succeeded: count("succeeded"),
      failed: count("failed"),
      cancelled: count("cancelled"),
    };
  }

  recoverAfterDaemonRestart(now = new Date()): readonly JobRecord[] {
    const snapshot = this.load();
    const recovered: JobRecord[] = [];
    const jobs = snapshot.jobs.map((job) => {
      if (job.state !== "leased" && job.state !== "running" && job.state !== "cancel_requested") return job;
      const target = job.state === "leased" && !job.startedAt ? "retry_pending" : "needs_recovery";
      const reason = target === "retry_pending" ? "Daemon restarted before worker execution began" : "Daemon restarted during ambiguous worker execution";
      let next = transitionJob(job, target, reason, now, job.assignedWorkerId);
      next = { ...next, leaseExpiresAt: undefined, lastHeartbeatAt: undefined, assignedWorkerId: undefined, recoveryReason: reason };
      recovered.push(next);
      return next;
    });
    if (recovered.length > 0) {
      this.save({ schemaVersion: 1, updatedAt: now.toISOString(), jobs });
      this.updateGauges(jobs);
    }
    return recovered;
  }

  recoverExpiredLeases(now = new Date()): readonly JobRecord[] {
    const snapshot = this.load();
    const recovered: JobRecord[] = [];
    const nowMs = now.getTime();
    const jobs = snapshot.jobs.map((job) => {
      if (!job.leaseExpiresAt || TERMINAL_JOB_STATES.has(job.state)) return job;
      if (Date.parse(job.leaseExpiresAt) > nowMs) return job;
      const target = job.state === "leased" && !job.startedAt ? "retry_pending" : "needs_recovery";
      const reason = target === "retry_pending" ? "Lease expired before first heartbeat" : "Lease expired after execution became ambiguous";
      let next = transitionJob(job, target, reason, now, job.assignedWorkerId);
      next = { ...next, leaseExpiresAt: undefined, assignedWorkerId: undefined, recoveryReason: reason };
      recovered.push(next);
      return next;
    });
    if (recovered.length > 0) {
      this.save({ schemaVersion: 1, updatedAt: now.toISOString(), jobs });
      defaultMetrics.leaseExpirationsTotal.inc(recovered.length);
      this.updateGauges(jobs);
    }
    return recovered;
  }

  claimNext(capabilities: WorkerCapabilities, leaseMs = DEFAULT_JOB_LEASE_MS, now = new Date()): JobRecord | undefined {
    this.recoverExpiredLeases(now);
    const snapshot = this.load();

    const maxConcurrent = capabilities.maxConcurrentJobs ?? 1;
    const workerActiveCount = snapshot.jobs.filter(
      (j) => j.assignedWorkerId === capabilities.workerId && (j.state === "leased" || j.state === "running" || j.state === "cancel_requested")
    ).length;
    if (workerActiveCount >= maxConcurrent) {
      return undefined;
    }

    const candidate = snapshot.jobs.find(
      (job) => (job.state === "queued" || job.state === "retry_pending") && isWorkerEligible(capabilities, job.requiredCapabilities, job.type)
    );
    if (!candidate) return undefined;
    const attempt = candidate.attempt + 1;
    const fencingToken = (candidate.fencingToken ?? candidate.attempt ?? 0) + 1;
    let claimed = transitionJob({ ...candidate, attempt }, "leased", "Worker lease acquired", now, capabilities.workerId);
    claimed = {
      ...claimed,
      fencingToken,
      assignedWorkerId: capabilities.workerId,
      leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
      lastHeartbeatAt: undefined,
      startedAt: undefined,
      cancelRequestedAt: undefined,
      recoveryReason: undefined,
      result: undefined,
    };
    const jobs = snapshot.jobs.map((job) => (job.id === candidate.id ? claimed : job));
    this.save({ schemaVersion: 1, updatedAt: now.toISOString(), jobs });

    const waitSeconds = Math.max(0, (now.getTime() - Date.parse(candidate.createdAt)) / 1000);
    defaultMetrics.queueWaitingDuration.observe(waitSeconds);
    defaultMetrics.fleetSchedulingDelay.observe(waitSeconds);
    defaultMetrics.jobsTotal.inc(1, { state: "leased" });
    this.updateGauges(jobs);

    return claimed;
  }

  heartbeat(
    id: string,
    workerId: string,
    attempt: number,
    leaseMs = DEFAULT_JOB_LEASE_MS,
    now = new Date(),
    fencingToken?: number
  ): { readonly job: JobRecord; readonly cancelRequested: boolean } {
    const snapshot = this.load();
    const current = snapshot.jobs.find((job) => job.id === id);
    if (!current) throw new Error(`Job not found: ${id}`);
    if (current.assignedWorkerId !== workerId || current.attempt !== attempt) {
      defaultMetrics.staleResultsRejectedTotal.inc(1, { reason: "lease_identity_mismatch" });
      defaultMetrics.leaseRenewalsTotal.inc(1, { status: "failure" });
      throw new Error("Job lease identity mismatch");
    }
    if (fencingToken !== undefined && current.fencingToken !== undefined && fencingToken !== current.fencingToken) {
      defaultMetrics.staleResultsRejectedTotal.inc(1, { reason: "fencing_mismatch" });
      defaultMetrics.leaseRenewalsTotal.inc(1, { status: "failure" });
      throw new Error("Job fencing token mismatch");
    }
    if (current.state === "cancel_requested") return { job: current, cancelRequested: true };
    if (current.state !== "leased" && current.state !== "running") throw new Error(`Job is not active: ${current.state}`);
    if (current.leaseExpiresAt && Date.parse(current.leaseExpiresAt) <= now.getTime()) {
      this.recoverExpiredLeases(now);
      defaultMetrics.staleResultsRejectedTotal.inc(1, { reason: "lease_expired" });
      defaultMetrics.leaseRenewalsTotal.inc(1, { status: "failure" });
      throw new Error("Job lease expired");
    }
    let next = current;
    if (current.state === "leased") {
      next = transitionJob(current, "running", "Worker heartbeat received; execution started", now, workerId);
      next = { ...next, startedAt: now.toISOString() };
    }
    next = {
      ...next,
      lastHeartbeatAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
    };
    const jobs = snapshot.jobs.map((job) => (job.id === id ? next : job));
    this.save({ schemaVersion: 1, updatedAt: now.toISOString(), jobs });
    defaultMetrics.leaseRenewalsTotal.inc(1, { status: "success" });
    this.updateGauges(jobs);
    return { job: next, cancelRequested: false };
  }

  requestCancel(id: string, reason = "Cancellation requested", now = new Date()): JobRecord {
    const snapshot = this.load();
    const current = snapshot.jobs.find((job) => job.id === id);
    if (!current) throw new Error(`Job not found: ${id}`);
    if (TERMINAL_JOB_STATES.has(current.state) || current.state === "cancel_requested") return current;

    defaultMetrics.cancellationsTotal.inc(1);

    if (current.state === "queued" || current.state === "retry_pending") {
      let cancelled = transitionJob(current, "cancelled", reason, now);
      cancelled = {
        ...cancelled,
        cancelRequestedAt: now.toISOString(),
        result: {
          attempt: current.attempt,
          status: "cancelled",
          sessionId: current.sessionId,
          detail: reason,
          finishedAt: now.toISOString(),
          ...(current.fencingToken !== undefined ? { fencingToken: current.fencingToken } : {}),
        },
      };
      const jobs = snapshot.jobs.map((job) => (job.id === id ? cancelled : job));
      this.save({ schemaVersion: 1, updatedAt: now.toISOString(), jobs });
      defaultMetrics.jobsTotal.inc(1, { state: "cancelled" });
      this.updateGauges(jobs);
      return cancelled;
    }

    const requested = transitionJob(current, "cancel_requested", reason, now, current.assignedWorkerId);
    const next = { ...requested, cancelRequestedAt: now.toISOString() };
    const jobs = snapshot.jobs.map((job) => (job.id === id ? next : job));
    this.save({ schemaVersion: 1, updatedAt: now.toISOString(), jobs });
    this.updateGauges(jobs);
    return next;
  }

  recover(id: string, reason = "Explicit recovery approved", now = new Date()): JobRecord {
    const snapshot = this.load();
    const current = snapshot.jobs.find((job) => job.id === id);
    if (!current) throw new Error(`Job not found: ${id}`);
    if (current.state !== "needs_recovery") throw new Error(`Job is not awaiting recovery: ${current.state}`);
    let next = transitionJob(current, "retry_pending", reason, now);
    next = {
      ...next,
      assignedWorkerId: undefined,
      leaseExpiresAt: undefined,
      lastHeartbeatAt: undefined,
      startedAt: undefined,
      cancelRequestedAt: undefined,
      recoveryReason: undefined,
      result: undefined,
    };
    const jobs = snapshot.jobs.map((job) => (job.id === id ? next : job));
    this.save({ schemaVersion: 1, updatedAt: now.toISOString(), jobs });
    defaultMetrics.jobRetriesTotal.inc(1);
    this.updateGauges(jobs);
    return next;
  }

  submitResult(
    id: string,
    workerId: string,
    attempt: number,
    result: Omit<JobResult, "attempt" | "finishedAt">,
    now = new Date(),
    fencingToken?: number
  ): { readonly job: JobRecord; readonly accepted: boolean; readonly duplicate: boolean } {
    const snapshot = this.load();
    const current = snapshot.jobs.find((job) => job.id === id);
    if (!current) throw new Error(`Job not found: ${id}`);
    const token = fencingToken ?? result.fencingToken;
    if (current.state === "succeeded" || current.state === "failed" || current.state === "cancelled") {
      if (current.result?.attempt === attempt) return { job: current, accepted: false, duplicate: true };
      defaultMetrics.staleResultsRejectedTotal.inc(1, { reason: "terminal_state" });
      throw new Error("Job result attempt is no longer current");
    }
    if (current.assignedWorkerId !== workerId || current.attempt !== attempt) {
      defaultMetrics.staleResultsRejectedTotal.inc(1, { reason: "worker_or_attempt_mismatch" });
      throw new Error("Job result identity mismatch");
    }
    if (current.state !== "leased" && current.state !== "running" && current.state !== "cancel_requested") {
      throw new Error(`Job cannot accept a result from state ${current.state}`);
    }
    if (current.state === "cancel_requested" && result.status !== "cancelled") {
      throw new Error("Cancelled job cannot accept a non-cancelled result");
    }
    if (token !== undefined && current.fencingToken !== undefined && token !== current.fencingToken) {
      defaultMetrics.staleResultsRejectedTotal.inc(1, { reason: "fencing_mismatch" });
      throw new Error("Job fencing token mismatch");
    }
    if (current.state !== "cancel_requested" && current.leaseExpiresAt && Date.parse(current.leaseExpiresAt) <= now.getTime()) {
      this.recoverExpiredLeases(now);
      defaultMetrics.staleResultsRejectedTotal.inc(1, { reason: "lease_expired" });
      throw new Error("Job lease expired before result submission");
    }
    if (current.state === "cancel_requested" && result.status !== "cancelled") {
      throw new Error("Cancelled job cannot accept a non-cancelled result");
    }
    const target: JobState = result.status;
    let next = transitionJob(current, target, result.detail ?? `Worker submitted ${result.status} result`, now, workerId);
    next = {
      ...next,
      leaseExpiresAt: undefined,
      result: {
        ...result,
        attempt,
        finishedAt: now.toISOString(),
        ...(current.fencingToken !== undefined ? { fencingToken: current.fencingToken } : {}),
      },
    };
    const jobs = snapshot.jobs.map((job) => (job.id === id ? next : job));
    this.save({ schemaVersion: 1, updatedAt: now.toISOString(), jobs });

    defaultMetrics.jobsTotal.inc(1, { state: result.status });
    if (current.startedAt) {
      const execSeconds = Math.max(0, (now.getTime() - Date.parse(current.startedAt)) / 1000);
      defaultMetrics.jobExecutionDuration.observe(execSeconds);
    }
    if (current.sampleMetadata) {
      const sampleKind = current.sampleMetadata.kind;
      defaultMetrics.samplesTotal.inc(1, { type: sampleKind, status: result.status === "succeeded" ? "accepted" : "rejected" });
    }
    this.updateGauges(jobs);

    return { job: next, accepted: true, duplicate: false };
  }
}

export function summarizeJob(job: JobRecord): {
  readonly id: string;
  readonly sessionId: string;
  readonly type: string;
  readonly state: JobState;
  readonly attempt: number;
  readonly fencingToken?: number;
  readonly workerId?: string;
  readonly leaseExpiresAt?: string;
  readonly lastHeartbeatAt?: string;
  readonly recoveryReason?: string;
} {
  return {
    id: job.id,
    sessionId: job.sessionId,
    type: job.type,
    state: job.state,
    attempt: job.attempt,
    ...(job.fencingToken !== undefined ? { fencingToken: job.fencingToken } : {}),
    ...(job.assignedWorkerId ? { workerId: job.assignedWorkerId } : {}),
    ...(job.leaseExpiresAt ? { leaseExpiresAt: job.leaseExpiresAt } : {}),
    ...(job.lastHeartbeatAt ? { lastHeartbeatAt: job.lastHeartbeatAt } : {}),
    ...(job.recoveryReason ? { recoveryReason: job.recoveryReason } : {}),
  };
}

export * from "./fleet-coordinator.js";
