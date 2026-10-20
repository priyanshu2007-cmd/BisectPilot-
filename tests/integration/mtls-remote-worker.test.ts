import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_EXECUTION_POLICY, type BisectJobPayload, type WorkerCapabilities } from "../../src/contracts/index.js";
import { DaemonClient, DaemonService, daemonBaseUrl } from "../../src/daemon/index.js";
import { WorkerService } from "../../src/worker/index.js";
import { generateTestTlsBundle, type TestTlsBundle } from "../fixtures/tls-certs.js";

const GOOD_SHA = "1111111111111111111111111111111111111111";
const BAD_SHA = "9999999999999999999999999999999999999999";

function createJobPayload(repoDir = "/tmp/repo"): BisectJobPayload {
  return {
    config: {
      schemaVersion: 1,
      profile: "functional",
      repositoryRoot: repoDir,
      workingDirectory: ".",
      goodRef: GOOD_SHA,
      badRef: BAD_SHA,
      oracle: { mode: "in-tree", command: { command: "node", args: ["check.mjs"], timeoutMs: 1_000 } },
      execution: { ...DEFAULT_EXECUTION_POLICY, confirmBeforeExecutingCode: false },
    },
    repository: { strategy: "preprovisioned", key: "default", expectedGoodSha: GOOD_SHA, expectedBadSha: BAD_SHA },
  };
}

const worker1Capabilities: WorkerCapabilities = {
  workerId: "worker-1",
  protocolVersion: 1,
  jobTypes: ["bisect"],
  repositoryKeys: ["default"],
  platform: process.platform,
  architecture: process.arch,
  maxConcurrentJobs: 1,
};

const worker2Capabilities: WorkerCapabilities = {
  workerId: "worker-2",
  protocolVersion: 1,
  jobTypes: ["bisect"],
  repositoryKeys: ["default"],
  platform: process.platform,
  architecture: process.arch,
  maxConcurrentJobs: 1,
};

describe("Feature A & B: Mutual TLS & Remote Worker Authorization", () => {
  it("authenticates daemon and worker bidirectionally via mTLS and executes jobs", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "bp-mtls-e2e-"));
    const bundle = generateTestTlsBundle(path.join(tmp, "certs"));
    const daemonStateDir = path.join(tmp, "daemon");
    const daemon = new DaemonService({
      stateDir: daemonStateDir,
      port: 0,
      tlsCertFile: bundle.serverCert,
      tlsKeyFile: bundle.serverKey,
      tlsCaFile: bundle.caCert,
      tlsRequireClientCert: true,
    });

    try {
      const state = await daemon.start();
      assert.equal(state.protocol, "https");
      assert.equal(state.tls?.enabled, true);
      assert.equal(state.tls?.clientAuthRequired, true);

      const client = new DaemonClient({
        baseUrl: daemonBaseUrl(state),
        tokenFile: state.tokenFile,
        tlsCertFile: bundle.worker1Cert,
        tlsKeyFile: bundle.worker1Key,
        tlsCaFile: bundle.caCert,
        tlsServername: "localhost",
      });

      // Health and status
      const health = await client.health();
      assert.equal(health.ok, true);

      // Register worker-1
      const registered = await client.registerWorker(worker1Capabilities);
      assert.equal(registered.registered, true);
      assert.equal(registered.workerId, "worker-1");

      const status = await client.status();
      assert.equal(status.workers.length, 1);
      assert.equal(status.workers[0]?.capabilities.workerId, "worker-1");
      assert.equal(status.workers[0]?.clientCertSubjectCn, "worker-1");
      assert.ok(status.workers[0]?.clientCertFingerprint);

      // Enqueue job and poll as worker-1
      const queued = await client.enqueue(createJobPayload());
      const polled = await client.poll(worker1Capabilities);
      assert.equal(polled.job?.id, queued.job.id);
      assert.equal(polled.job?.state, "leased");

      // Heartbeat
      const heartbeat = await client.heartbeat(polled.job!.id, "worker-1", polled.job!.attempt);
      assert.equal(heartbeat.cancelRequested, false);

      // Submit result
      const submitted = await client.result(polled.job!.id, "worker-1", polled.job!.attempt, {
        status: "succeeded",
        sessionId: polled.job!.sessionId,
        detail: "mTLS run succeeded",
      });
      assert.equal(submitted.accepted, true);
    } finally {
      await daemon.stop().catch(() => undefined);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects client when daemon presents an untrusted server certificate", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "bp-untrusted-srv-"));
    const bundle = generateTestTlsBundle(path.join(tmp, "certs"));
    const daemonStateDir = path.join(tmp, "daemon");
    // Daemon uses cert signed by untrustedCa
    const daemon = new DaemonService({
      stateDir: daemonStateDir,
      port: 0,
      tlsCertFile: bundle.workerUntrustedCert, // signed by untrustedCa
      tlsKeyFile: bundle.workerUntrustedKey,
      tlsCaFile: bundle.caCert,
      tlsRequireClientCert: true,
    });

    try {
      const state = await daemon.start();
      // Worker trusts only rootCa (bundle.caCert)
      const client = new DaemonClient({
        baseUrl: daemonBaseUrl(state),
        tokenFile: state.tokenFile,
        tlsCertFile: bundle.worker1Cert,
        tlsKeyFile: bundle.worker1Key,
        tlsCaFile: bundle.caCert,
        tlsServername: "localhost",
      });

      await assert.rejects(
        () => client.health(),
        /unable to verify the first certificate|UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT|ERR_TLS_CERT_ALTNAME_INVALID/
      );
    } finally {
      await daemon.stop().catch(() => undefined);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects client when worker presents an untrusted client certificate", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "bp-untrusted-cli-"));
    const bundle = generateTestTlsBundle(path.join(tmp, "certs"));
    const daemonStateDir = path.join(tmp, "daemon");
    // Daemon trusts only rootCa (bundle.caCert)
    const daemon = new DaemonService({
      stateDir: daemonStateDir,
      port: 0,
      tlsCertFile: bundle.serverCert,
      tlsKeyFile: bundle.serverKey,
      tlsCaFile: bundle.caCert,
      tlsRequireClientCert: true,
    });

    try {
      const state = await daemon.start();
      // Worker presents cert signed by untrustedCa
      const client = new DaemonClient({
        baseUrl: daemonBaseUrl(state),
        tokenFile: state.tokenFile,
        tlsCertFile: bundle.workerUntrustedCert,
        tlsKeyFile: bundle.workerUntrustedKey,
        tlsCaFile: bundle.caCert,
        tlsServername: "localhost",
      });

      await assert.rejects(
        () => client.health(),
        /socket hang up|ECONNRESET|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_SIGNATURE_FAILURE/
      );
    } finally {
      await daemon.stop().catch(() => undefined);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects connection when daemon hostname does not match expected servername", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "bp-hostname-mismatch-"));
    const bundle = generateTestTlsBundle(path.join(tmp, "certs"));
    const daemonStateDir = path.join(tmp, "daemon");
    // Daemon presents certificate with SAN: otherhost
    const daemon = new DaemonService({
      stateDir: daemonStateDir,
      port: 0,
      tlsCertFile: bundle.serverWrongHostCert,
      tlsKeyFile: bundle.serverWrongHostKey,
      tlsCaFile: bundle.caCert,
      tlsRequireClientCert: true,
    });

    try {
      const state = await daemon.start();
      // Worker connects to 127.0.0.1 (not otherhost)
      const client = new DaemonClient({
        baseUrl: daemonBaseUrl(state),
        tokenFile: state.tokenFile,
        tlsCertFile: bundle.worker1Cert,
        tlsKeyFile: bundle.worker1Key,
        tlsCaFile: bundle.caCert,
      });

      await assert.rejects(
        () => client.health(),
        /ERR_TLS_CERT_ALTNAME_INVALID|Hostname\/IP does not match certificate/
      );
    } finally {
      await daemon.stop().catch(() => undefined);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects connection when client certificate is missing on mTLS daemon", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "bp-missing-cert-"));
    const bundle = generateTestTlsBundle(path.join(tmp, "certs"));
    const daemonStateDir = path.join(tmp, "daemon");
    const daemon = new DaemonService({
      stateDir: daemonStateDir,
      port: 0,
      tlsCertFile: bundle.serverCert,
      tlsKeyFile: bundle.serverKey,
      tlsCaFile: bundle.caCert,
      tlsRequireClientCert: true,
    });

    try {
      const state = await daemon.start();
      // Client does not provide client certificate
      const client = new DaemonClient({
        baseUrl: daemonBaseUrl(state),
        tokenFile: state.tokenFile,
        tlsCaFile: bundle.caCert,
        tlsServername: "localhost",
      });

      await assert.rejects(
        () => client.health(),
        /certificate required|socket hang up|ECONNRESET|ERR_SSL_PEER_DID_NOT_RETURN_A_CERTIFICATE/
      );
    } finally {
      await daemon.stop().catch(() => undefined);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects worker request when client certificate CN does not match claimed workerId", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "bp-id-mismatch-"));
    const bundle = generateTestTlsBundle(path.join(tmp, "certs"));
    const daemonStateDir = path.join(tmp, "daemon");
    const daemon = new DaemonService({
      stateDir: daemonStateDir,
      port: 0,
      tlsCertFile: bundle.serverCert,
      tlsKeyFile: bundle.serverKey,
      tlsCaFile: bundle.caCert,
      tlsRequireClientCert: true,
    });

    try {
      const state = await daemon.start();
      // Client cert has CN = worker-1
      const client = new DaemonClient({
        baseUrl: daemonBaseUrl(state),
        tokenFile: state.tokenFile,
        tlsCertFile: bundle.worker1Cert,
        tlsKeyFile: bundle.worker1Key,
        tlsCaFile: bundle.caCert,
        tlsServername: "localhost",
      });

      // Attempt to register as worker-2
      await assert.rejects(
        () => client.registerWorker({ ...worker1Capabilities, workerId: "worker-2" }),
        /Client certificate CN 'worker-1' does not match workerId 'worker-2'/
      );
    } finally {
      await daemon.stop().catch(() => undefined);
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("Feature C: Credential Rotation & Revocation", () => {
  it("enforces revocation by client certificate fingerprint and worker ID", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "bp-revocation-"));
    const bundle = generateTestTlsBundle(path.join(tmp, "certs"));
    const daemonStateDir = path.join(tmp, "daemon");
    const daemon = new DaemonService({
      stateDir: daemonStateDir,
      port: 0,
      tlsCertFile: bundle.serverCert,
      tlsKeyFile: bundle.serverKey,
      tlsCaFile: bundle.caCert,
      tlsRequireClientCert: true,
    });

    try {
      const state = await daemon.start();
      const client1 = new DaemonClient({
        baseUrl: daemonBaseUrl(state),
        tokenFile: state.tokenFile,
        tlsCertFile: bundle.worker1Cert,
        tlsKeyFile: bundle.worker1Key,
        tlsCaFile: bundle.caCert,
        tlsServername: "localhost",
      });

      // Worker 1 registers successfully
      await client1.registerWorker(worker1Capabilities);
      const status1 = await client1.status();
      const fp = status1.workers[0]?.clientCertFingerprint;
      assert.ok(fp);

      // Revoke certificate fingerprint
      daemon.revokeClientCertificate(fp);

      // Subsequent request with revoked cert must be rejected with 403
      await assert.rejects(
        () => client1.poll(worker1Capabilities),
        /Client certificate has been revoked/
      );

      // Client 2 with worker2Cert
      const client2 = new DaemonClient({
        baseUrl: daemonBaseUrl(state),
        tokenFile: state.tokenFile,
        tlsCertFile: bundle.worker2Cert,
        tlsKeyFile: bundle.worker2Key,
        tlsCaFile: bundle.caCert,
        tlsServername: "localhost",
      });

      await client2.registerWorker(worker2Capabilities);

      // Revoke worker-2 by ID
      daemon.revokeWorker("worker-2");

      // Subsequent request by revoked worker ID must be rejected with 403
      await assert.rejects(
        () => client2.poll(worker2Capabilities),
        /Worker 'worker-2' has been revoked/
      );
    } finally {
      await daemon.stop().catch(() => undefined);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("supports dynamic server TLS rotation and client credential rotation without restart", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "bp-rotation-"));
    const bundle = generateTestTlsBundle(path.join(tmp, "certs"));
    const daemonStateDir = path.join(tmp, "daemon");
    const daemon = new DaemonService({
      stateDir: daemonStateDir,
      port: 0,
      tlsCertFile: bundle.serverCert,
      tlsKeyFile: bundle.serverKey,
      tlsCaFile: bundle.caCert,
      tlsRequireClientCert: true,
    });

    try {
      const state = await daemon.start();
      const client = new DaemonClient({
        baseUrl: daemonBaseUrl(state),
        tokenFile: state.tokenFile,
        tlsCertFile: bundle.worker1Cert,
        tlsKeyFile: bundle.worker1Key,
        tlsCaFile: bundle.caCert,
        tlsServername: "localhost",
      });

      assert.equal((await client.health()).ok, true);

      // Rotate server TLS credentials to rotatedServer
      daemon.rotateServerTls({
        certFile: bundle.rotatedServerCert,
        keyFile: bundle.rotatedServerKey,
        caFile: bundle.caCert,
      });

      // Rotate client credentials to rotatedWorker1
      client.rotateTlsCredentials({
        certFile: bundle.rotatedWorker1Cert,
        keyFile: bundle.rotatedWorker1Key,
      });

      // Request succeeds with rotated credentials
      assert.equal((await client.health()).ok, true);
      const reg = await client.registerWorker(worker1Capabilities);
      assert.equal(reg.registered, true);
    } finally {
      await daemon.stop().catch(() => undefined);
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("Lease Ownership & Remote Boundary Protection", () => {
  it("prevents cross-worker job hijacking and rejects expired leases", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "bp-hijack-"));
    const bundle = generateTestTlsBundle(path.join(tmp, "certs"));
    const daemonStateDir = path.join(tmp, "daemon");
    const daemon = new DaemonService({
      stateDir: daemonStateDir,
      port: 0,
      leaseMs: 5_000,
      heartbeatMs: 1_000,
      tlsCertFile: bundle.serverCert,
      tlsKeyFile: bundle.serverKey,
      tlsCaFile: bundle.caCert,
      tlsRequireClientCert: true,
    });

    try {
      const state = await daemon.start();
      const client1 = new DaemonClient({
        baseUrl: daemonBaseUrl(state),
        tokenFile: state.tokenFile,
        tlsCertFile: bundle.worker1Cert,
        tlsKeyFile: bundle.worker1Key,
        tlsCaFile: bundle.caCert,
        tlsServername: "localhost",
      });
      const client2 = new DaemonClient({
        baseUrl: daemonBaseUrl(state),
        tokenFile: state.tokenFile,
        tlsCertFile: bundle.worker2Cert,
        tlsKeyFile: bundle.worker2Key,
        tlsCaFile: bundle.caCert,
        tlsServername: "localhost",
      });

      await client1.registerWorker(worker1Capabilities);
      await client2.registerWorker(worker2Capabilities);

      const queued = await client1.enqueue(createJobPayload());
      const polled = await client1.poll(worker1Capabilities);
      assert.equal(polled.job?.id, queued.job.id);
      assert.equal(polled.job?.assignedWorkerId, "worker-1");

      // Worker 2 attempts to heartbeat or submit result for worker-1's job
      await assert.rejects(
        () => client2.heartbeat(polled.job!.id, "worker-2", polled.job!.attempt),
        /Job lease identity mismatch/
      );
      await assert.rejects(
        () => client2.result(polled.job!.id, "worker-2", polled.job!.attempt, {
          status: "succeeded",
          sessionId: polled.job!.sessionId,
        }),
        /Job result identity mismatch/
      );
    } finally {
      await daemon.stop().catch(() => undefined);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses plain HTTP for non-loopback URLs", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "bp-nonloopback-"));
    const tokenFile = path.join(tmp, "daemon.token");
    writeFileSync(tokenFile, `${"a".repeat(64)}\n`, { mode: 0o600 });
    try {
      assert.throws(
        () => new DaemonClient({ baseUrl: "http://192.168.1.10:4317", tokenFile }),
        /Plain HTTP is allowed only for loopback daemon URLs/
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
