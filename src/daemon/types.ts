import type { AtomicJobStore, summarizeJob } from "../jobs/index.js";
import type { WorkerCapabilities } from "../contracts/index.js";

export type DaemonLifecycleState = "starting" | "running" | "stopping" | "stopped" | "failed" | "recovery_required";

export interface DaemonTlsState {
  readonly enabled: boolean;
  readonly clientAuthRequired: boolean;
  readonly serverCertFingerprint?: string;
  readonly allowedIdentities?: readonly string[];
  readonly revokedFingerprintsCount: number;
  readonly revokedWorkersCount: number;
}

export interface DaemonState {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly hostname: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly state: DaemonLifecycleState;
  readonly host: string;
  readonly port: number;
  readonly protocol: "http" | "https";
  readonly tokenFile: string;
  readonly queueFile: string;
  readonly leaseMs: number;
  readonly heartbeatMs: number;
  readonly tls?: DaemonTlsState;
  readonly lastError?: string;
}

export interface DaemonServiceOptions {
  readonly stateDir: string;
  readonly host?: string;
  readonly port?: number;
  readonly tokenFile?: string;
  readonly leaseMs?: number;
  readonly heartbeatMs?: number;
  readonly tlsCertFile?: string;
  readonly tlsKeyFile?: string;
  readonly tlsCaFile?: string;
  readonly tlsRequireClientCert?: boolean;
  readonly tlsAllowedIdentities?: readonly string[];
  readonly tlsAllowedFingerprints?: readonly string[];
  readonly tlsRevokedFingerprints?: readonly string[];
  readonly recoverStaleState?: boolean;
  readonly now?: () => Date;
}

export interface RegisteredWorker {
  readonly capabilities: WorkerCapabilities;
  readonly registeredAt: string;
  readonly lastSeenAt: string;
  readonly activeJobId?: string;
  readonly clientCertFingerprint?: string;
  readonly clientCertSubjectCn?: string;
}

export interface DaemonTelemetryStatus {
  readonly tracingEnabled: boolean;
  readonly metricsActive: boolean;
  readonly metricsEndpoint: string;
}

export interface DaemonStatus {
  readonly state: DaemonState;
  readonly pidAlive: boolean;
  readonly queue: ReturnType<AtomicJobStore["summary"]>;
  readonly jobs: readonly ReturnType<typeof summarizeJob>[];
  readonly workers: readonly RegisteredWorker[];
  readonly telemetry?: DaemonTelemetryStatus;
}

export interface ClientIdentity {
  readonly fingerprint256?: string;
  readonly subjectCn?: string;
}
