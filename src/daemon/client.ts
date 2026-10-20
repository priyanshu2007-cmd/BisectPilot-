import * as http from "node:http";
import * as https from "node:https";
import * as tls from "node:tls";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { RequestOptions } from "node:http";
import type { DaemonState, DaemonStatus } from "./index.js";
import type { BisectJobPayload, JobRecord, WorkerCapabilities } from "../contracts/index.js";
import type { summarizeJob } from "../jobs/index.js";
import { formatTraceParent, getActiveTraceContext } from "../telemetry/index.js";

const MAX_RESPONSE_BYTES = 512 * 1024;

function readTokenFile(tokenFile: string): string {
  if (process.platform !== "win32") {
    const mode = statSync(tokenFile).mode & 0o777;
    if ((mode & 0o077) !== 0) throw new Error(`Token file permissions are too broad: ${tokenFile}`);
  }
  const token = readFileSync(tokenFile, "utf-8").trim();
  if (token.length < 32 || token.length > 256) throw new Error(`Invalid daemon token file: ${tokenFile}`);
  return token;
}

function checkKeyPermissions(keyPath: string): void {
  if (!existsSync(keyPath)) throw new Error(`TLS key file not found: ${keyPath}`);
  if (process.platform !== "win32") {
    const mode = statSync(keyPath).mode & 0o777;
    if ((mode & 0o077) !== 0) throw new Error(`TLS private key file permissions are too broad: ${keyPath}`);
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
}

export interface DaemonClientOptions {
  readonly baseUrl: string;
  readonly tokenFile: string;
  readonly timeoutMs?: number;
  readonly tlsCertFile?: string;
  readonly tlsKeyFile?: string;
  readonly tlsCaFile?: string;
  readonly tlsServername?: string;
}

export interface DaemonPollResponse {
  readonly job: JobRecord | null;
  readonly cancelRequested: boolean;
}

export interface DaemonHeartbeatResponse {
  readonly cancelRequested: boolean;
  readonly job: Record<string, unknown>;
}

export type DaemonJobSummary = ReturnType<typeof summarizeJob>;

export class DaemonClient {
  readonly baseUrl: URL;
  private readonly token: string;
  private readonly timeoutMs: number;
  private tlsCertFile?: string;
  private tlsKeyFile?: string;
  private tlsCaFile?: string;
  private tlsServername?: string;

  constructor(options: DaemonClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    if (this.baseUrl.protocol !== "http:" && this.baseUrl.protocol !== "https:") {
      throw new Error("Daemon URL must use http or https");
    }
    if (this.baseUrl.protocol === "http:" && !isLoopbackHost(this.baseUrl.hostname)) {
      throw new Error("Plain HTTP is allowed only for loopback daemon URLs");
    }
    this.token = readTokenFile(options.tokenFile);
    this.timeoutMs = options.timeoutMs ?? 10_000;

    if (this.baseUrl.protocol === "https:") {
      if (options.tlsCertFile && !existsSync(options.tlsCertFile)) {
        throw new Error(`TLS cert file not found: ${options.tlsCertFile}`);
      }
      if (options.tlsKeyFile) {
        checkKeyPermissions(options.tlsKeyFile);
      }
      if (options.tlsCaFile && !existsSync(options.tlsCaFile)) {
        throw new Error(`TLS CA file not found: ${options.tlsCaFile}`);
      }
      if (!isLoopbackHost(this.baseUrl.hostname)) {
        if (!options.tlsCertFile || !options.tlsKeyFile || !options.tlsCaFile) {
          throw new Error("Remote daemon HTTPS connections require client certificate (--tls-cert), private key (--tls-key), and CA certificate (--tls-ca)");
        }
      }
      this.tlsCertFile = options.tlsCertFile ? path.resolve(options.tlsCertFile) : undefined;
      this.tlsKeyFile = options.tlsKeyFile ? path.resolve(options.tlsKeyFile) : undefined;
      this.tlsCaFile = options.tlsCaFile ? path.resolve(options.tlsCaFile) : undefined;
      this.tlsServername = options.tlsServername;
    }
  }

  rotateTlsCredentials(options: { certFile?: string; keyFile?: string; caFile?: string; servername?: string }): void {
    const certPath = options.certFile ? path.resolve(options.certFile) : undefined;
    const keyPath = options.keyFile ? path.resolve(options.keyFile) : undefined;
    const caPath = options.caFile ? path.resolve(options.caFile) : undefined;

    if (certPath && !existsSync(certPath)) throw new Error(`Cert file not found: ${certPath}`);
    if (keyPath) checkKeyPermissions(keyPath);
    if (caPath && !existsSync(caPath)) throw new Error(`CA file not found: ${caPath}`);

    if (certPath && keyPath) {
      const cert = readFileSync(certPath);
      const key = readFileSync(keyPath);
      const ca = caPath ? readFileSync(caPath) : this.tlsCaFile ? readFileSync(this.tlsCaFile) : undefined;
      tls.createSecureContext({ cert, key, ...(ca ? { ca } : {}) });
    }

    if (certPath) this.tlsCertFile = certPath;
    if (keyPath) this.tlsKeyFile = keyPath;
    if (caPath) this.tlsCaFile = caPath;
    if (options.servername !== undefined) this.tlsServername = options.servername;
  }

  async request<T>(method: "GET" | "POST", route: string, body?: unknown, authenticated = true): Promise<T> {
    const url = new URL(route, this.baseUrl);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const activeContext = getActiveTraceContext();
    const requestOptions: https.RequestOptions = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method,
      headers: {
        accept: "application/json",
        ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
        ...(authenticated ? { authorization: `Bearer ${this.token}` } : {}),
        ...(activeContext ? { traceparent: formatTraceParent(activeContext) } : {}),
      },
      ...(this.tlsCertFile ? { cert: readFileSync(this.tlsCertFile) } : {}),
      ...(this.tlsKeyFile ? { key: readFileSync(this.tlsKeyFile) } : {}),
      ...(this.tlsCaFile ? { ca: readFileSync(this.tlsCaFile) } : {}),
      ...(this.tlsServername ? { servername: this.tlsServername } : {}),
      rejectUnauthorized: true,
    };
    const transport = url.protocol === "https:" ? https : http;
    return await new Promise<T>((resolve, reject) => {
      const req = transport.request(requestOptions, (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            req.destroy(new Error("Daemon response exceeds size limit"));
            return;
          }
          chunks.push(buffer);
        });
        res.on("end", () => {
          let parsed: unknown = {};
          try {
            parsed = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
          } catch {
            reject(new Error(`Daemon returned invalid JSON (HTTP ${res.statusCode ?? 0})`));
            return;
          }
          if ((res.statusCode ?? 500) < 200 || (res.statusCode ?? 500) >= 300) {
            const detail = typeof parsed === "object" && parsed !== null && typeof (parsed as { error?: unknown }).error === "string"
              ? (parsed as { error: string }).error
              : "request rejected";
            reject(new Error(`Daemon request failed (${res.statusCode}): ${detail}`));
            return;
          }
          resolve(parsed as T);
        });
      });
      req.setTimeout(this.timeoutMs, () => req.destroy(new Error("Daemon request timed out")));
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  health(): Promise<{ ok: boolean; protocolVersion: number }> {
    return this.request("GET", "/health", undefined, false);
  }

  status(): Promise<DaemonStatus> {
    return this.request("GET", "/v1/status");
  }

  enqueue(payload: BisectJobPayload): Promise<{ job: DaemonJobSummary }> {
    return this.request("POST", "/v1/jobs", { payload });
  }

  getJob(id: string): Promise<{ job: DaemonJobSummary; result: unknown }> {
    return this.request("GET", `/v1/jobs/${encodeURIComponent(id)}`);
  }

  cancel(id: string, reason?: string): Promise<{ job: DaemonJobSummary }> {
    return this.request("POST", `/v1/jobs/${encodeURIComponent(id)}/cancel`, reason ? { reason } : {});
  }

  recover(id: string, reason?: string): Promise<{ job: DaemonJobSummary }> {
    return this.request("POST", `/v1/jobs/${encodeURIComponent(id)}/recover`, reason ? { reason } : {});
  }

  shutdown(): Promise<{ accepted: boolean }> {
    return this.request("POST", "/v1/shutdown", {});
  }

  registerWorker(capabilities: WorkerCapabilities): Promise<{ registered: boolean; workerId: string; leaseMs: number }> {
    return this.request("POST", "/v1/workers/register", capabilities);
  }

  deregisterWorker(workerId: string): Promise<{ deregistered: boolean }> {
    return this.request("POST", "/v1/workers/deregister", { workerId });
  }

  poll(capabilities: WorkerCapabilities): Promise<DaemonPollResponse> {
    return this.request("POST", "/v1/jobs/poll", capabilities);
  }

  heartbeat(jobId: string, workerId: string, attempt: number, fencingToken?: number): Promise<DaemonHeartbeatResponse> {
    return this.request("POST", `/v1/jobs/${encodeURIComponent(jobId)}/heartbeat`, { workerId, attempt, ...(fencingToken !== undefined ? { fencingToken } : {}) });
  }

  result(jobId: string, workerId: string, attempt: number, result: Record<string, unknown>, fencingToken?: number): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/jobs/${encodeURIComponent(jobId)}/result`, { workerId, attempt, ...(fencingToken !== undefined ? { fencingToken } : {}), ...result });
  }

  revoke(target: { fingerprint?: string; workerId?: string; reason?: string }): Promise<{ ok: boolean; revokedFingerprintsCount: number; revokedWorkersCount: number }> {
    return this.request("POST", "/v1/admin/revoke", target);
  }

  async scrapeMetrics(authenticated = true): Promise<string> {
    const url = new URL("/metrics", this.baseUrl);
    const activeContext = getActiveTraceContext();
    const requestOptions: https.RequestOptions = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
      path: url.pathname,
      method: "GET",
      headers: {
        accept: "text/plain",
        ...(authenticated ? { authorization: `Bearer ${this.token}` } : {}),
        ...(activeContext ? { traceparent: formatTraceParent(activeContext) } : {}),
      },
      ...(this.tlsCertFile ? { cert: readFileSync(this.tlsCertFile) } : {}),
      ...(this.tlsKeyFile ? { key: readFileSync(this.tlsKeyFile) } : {}),
      ...(this.tlsCaFile ? { ca: readFileSync(this.tlsCaFile) } : {}),
      ...(this.tlsServername ? { servername: this.tlsServername } : {}),
      rejectUnauthorized: true,
    };
    const transport = url.protocol === "https:" ? https : http;
    return await new Promise<string>((resolve, reject) => {
      const req = transport.request(requestOptions, (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            req.destroy(new Error("Metrics response exceeds size limit"));
            return;
          }
          chunks.push(buffer);
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 500) < 200 || (res.statusCode ?? 500) >= 300) {
            reject(new Error(`Daemon metrics request failed (${res.statusCode}): ${text.slice(0, 500)}`));
            return;
          }
          resolve(text);
        });
      });
      req.setTimeout(this.timeoutMs, () => req.destroy(new Error("Daemon request timed out")));
      req.on("error", reject);
      req.end();
    });
  }
}

export function daemonBaseUrl(state: DaemonState): string {
  const host = state.host.includes(":") && !state.host.startsWith("[") ? `[${state.host}]` : state.host;
  return `${state.protocol}://${host}:${state.port}`;
}
