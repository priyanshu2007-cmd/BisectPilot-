# BisectPilot — Real Multi-Machine Mutual-TLS Worker Execution Runbook

This runbook specifies the configuration, deployment, certificate architecture, verification workflow, and negative failure modes for operating BisectPilot daemons and remote workers across distinct physical or virtual machines connected over an isolated IP network.

---

## 1. Physical Architecture & Network Topology

```
+-------------------------------------------------------------+
| Machine A: Daemon Coordinator                               |
| IP: 192.168.1.100 (Subnet: 192.168.1.0/24)                  |
| Hostname: daemon.internal                                    |
| Ports: 8443 (HTTPS mTLS Daemon API)                         |
| Files:                                                      |
|   - ca.crt (Dedicated Root CA Certificate)                  |
|   - daemon.crt (Server Cert with SAN: daemon.internal, IP)  |
|   - daemon.key (Server Private Key, mode 0600)              |
|   - daemon.token (Bearer token for API auth, mode 0600)     |
+-------------------------------------------------------------+
                               |
               Mutual TLS (TLS 1.3 / mTLS)
             Private Subnet (Restricted Path)
                               |
                               v
+-------------------------------------------------------------+
| Machine B: Remote Worker Node                               |
| IP: 192.168.1.101 (Subnet: 192.168.1.0/24)                  |
| Hostname: worker-node-1.internal                            |
| Worker ID: worker-node-1 (must match Client Cert CN)        |
| Files:                                                      |
|   - ca.crt (Dedicated Root CA Certificate)                  |
|   - worker-1.crt (Client Cert with CN: worker-node-1)       |
|   - worker-1.key (Client Private Key, mode 0600)            |
|   - daemon.token (Shared secret token copy, mode 0600)      |
|   - /var/git/project (Pre-provisioned bare or cloned repo)  |
+-------------------------------------------------------------+
```

---

## 2. Dedicated Test PKI Generation

Generate a dedicated Public Key Infrastructure (PKI) for this deployment. Never reuse development keys or expose keys to public repositories.

### Step 2.1 — Certificate Authority (CA)
```bash
# Generate private CA key
openssl genrsa -out ca.key 4096

# Generate self-signed Root CA certificate (valid for 365 days)
openssl req -x509 -new -nodes -key ca.key -sha256 -days 365 \
  -subj "/C=US/ST=Security/O=BisectPilot Test/CN=BisectPilot Root CA" \
  -out ca.crt
```

### Step 2.2 — Daemon Server Certificate (with SAN)
The daemon certificate MUST include Subject Alternative Names (SAN) matching Machine A's DNS hostname and IP address.
Create `daemon-san.ext`:
```ini
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage = digitalSignature, nonRepudiation, keyEncipherment, dataEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = daemon.internal
IP.1 = 192.168.1.100
```

Generate daemon key and CSR:
```bash
openssl genrsa -out daemon.key 2048
chmod 0600 daemon.key

openssl req -new -key daemon.key \
  -subj "/C=US/ST=Security/O=BisectPilot Test/CN=daemon.internal" \
  -out daemon.csr

openssl x509 -req -in daemon.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out daemon.crt -days 90 -sha256 -extfile daemon-san.ext
```

### Step 2.3 — Worker Client Certificate (CN matching Worker ID)
The worker certificate MUST have its Common Name (CN) set to the exact `workerId` configured on the worker.
Create `worker-ext.ext`:
```ini
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = clientAuth
```

Generate worker key and CSR:
```bash
openssl genrsa -out worker-1.key 2048
chmod 0600 worker-1.key

openssl req -new -key worker-1.key \
  -subj "/C=US/ST=Security/O=BisectPilot Test/CN=worker-node-1" \
  -out worker-1.csr

openssl x509 -req -in worker-1.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out worker-1.crt -days 90 -sha256 -extfile worker-ext.ext
```

---

## 3. Deployment Runbook

### Step 3.1 — Setup on Machine A (Daemon Host)
1. Install BisectPilot package or build locally:
   ```bash
   npm run build
   ```
2. Initialize daemon state directory:
   ```bash
   mkdir -p /var/run/bisectpilot-daemon
   chmod 0700 /var/run/bisectpilot-daemon
   ```
3. Start the Daemon with mTLS enforcement:
   ```bash
   node dist/src/daemon/cli.js start \
     --state-dir /var/run/bisectpilot-daemon \
     --port 8443 \
     --bind 192.168.1.100 \
     --tls-cert /path/to/daemon.crt \
     --tls-key /path/to/daemon.key \
     --tls-ca /path/to/ca.crt \
     --require-client-cert
   ```
4. Verify daemon health:
   ```bash
   curl --cacert /path/to/ca.crt \
        --cert /path/to/daemon.crt \
        --key /path/to/daemon.key \
        https://192.168.1.100:8443/api/v1/health
   # Expected response: {"ok":true}
   ```
5. Securely transfer `ca.crt`, `worker-1.crt`, `worker-1.key`, and `/var/run/bisectpilot-daemon/daemon.token` to Machine B over SSH/SCP:
   ```bash
   scp ca.crt worker-1.crt worker-1.key /var/run/bisectpilot-daemon/daemon.token user@192.168.1.101:/etc/bisectpilot/
   ```

### Step 3.2 — Setup on Machine B (Worker Host)
1. Ensure the target repository is pre-provisioned:
   ```bash
   git clone https://internal-git.company.com/repo.git /var/git/project
   ```
2. Restrict permissions on credentials:
   ```bash
   chmod 0600 /etc/bisectpilot/worker-1.key /etc/bisectpilot/daemon.token
   ```
3. Start the Remote Worker service:
   ```bash
   node dist/src/worker/cli.js start \
     --state-dir /var/run/bisectpilot-worker \
     --server https://192.168.1.100:8443 \
     --token-file /etc/bisectpilot/daemon.token \
     --tls-cert /etc/bisectpilot/worker-1.crt \
     --tls-key /etc/bisectpilot/worker-1.key \
     --tls-ca /etc/bisectpilot/ca.crt \
     --tls-servername daemon.internal \
     --worker-id worker-node-1 \
     --repo default=/var/git/project
   ```
4. Verify registration on Machine A:
   ```bash
   # Status check on Machine A shows active registered worker:
   node dist/src/daemon/cli.js status --state-dir /var/run/bisectpilot-daemon
   # Expected output includes: worker-node-1, CN=worker-node-1, clientCertFingerprint
   ```

---

## 4. End-to-End Distributed Job Lifecycle Verification

1. **Job Creation**: On Machine A, trigger bisection using the fleet coordinator:
   ```bash
   bisectpilot bisect --good v1.0.0 --bad v1.2.0 --fleet remote
   ```
2. **Scheduling**: Daemon coordinator queues revision evaluation jobs for commits between good and bad bounds.
3. **Claim & Lease**: Worker on Machine B polls, authenticates via mTLS certificate `worker-node-1`, and is granted a job with attempt ID `1` and a 30-second lease with 5-second heartbeat intervals.
4. **Execution**: Worker isolates revision in dedicated worktree on Machine B, runs the oracle, streams heartbeats back to Machine A.
5. **Result Submission**: Worker sends cryptographic result payload over mTLS. Machine A validates that:
   - Worker ID in request body matches TLS peer certificate CN (`worker-node-1`).
   - Lease is currently active and belongs to `worker-node-1`.
   - Attempt sequence matches current lease attempt.
   - Result is accepted (HTTP 200 `{"accepted": true}`).
6. **Authoritative Ledger & Conclusion**: Daemon records classification into `ledger.jsonl`, advances binary search bounds, repeats until regression commit is pinpointed.

---

## 5. Network Interruption & Resiliency Verification

### 5.1 Simulated Network Partition
While Machine B is evaluating a revision, simulate an abrupt network partition on Machine A:
```bash
# On Machine A: block traffic from Machine B
sudo iptables -A INPUT -s 192.168.1.101 -j DROP
```

**Verified Behavior**:
1. Daemon detects missed heartbeats after 30 seconds (`leaseMs` expired).
2. Daemon reclaims the job, increments attempt counter, and transitions job back to `queued` (or assigns to another worker).
3. Restore network connectivity on Machine A:
   ```bash
   sudo iptables -D INPUT -s 192.168.1.101 -j DROP
   ```
4. Machine B attempts to submit result from expired attempt 1.
5. Daemon rejects with HTTP 409 Conflict: `Job lease identity mismatch` / `Expired lease`.
6. Stale result is discarded; authoritative ledger remains untampered.

### 5.2 Negative Security Checks
- **Untrusted Client Cert**: If a worker presents a certificate signed by an untrusted CA, TLS handshake is terminated immediately by daemon (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`).
- **CN Mismatch / Identity Impersonation**: If a client with cert CN `worker-node-1` specifies `--worker-id worker-node-2`, daemon rejects with HTTP 403 `Client certificate CN does not match claimed workerId`.
- **Certificate Revocation**: When daemon revokes a worker cert SHA-256 fingerprint:
  ```bash
  # Revocation on Machine A:
  # Subsequent requests return HTTP 403 "Client certificate has been revoked"
  ```
- **Plain HTTP Rejection**: Non-loopback plain HTTP connections (`http://192.168.1.100:8443`) are rejected at the client layer (`Plain HTTP is allowed only for loopback daemon URLs`).

---

## 6. Current Verification Status

- **Loopback mTLS Automated Suite**: `PASS` (`tests/integration/mtls-remote-worker.test.ts` — 10 unit/integration tests covering mTLS handshake, untrusted server/client, hostname/SAN validation, CN identity matching, dynamic credential rotation, and fingerprint revocation).
- **Physical Multi-Machine Execution**: `BLOCKED` / `UNVERIFIED` (requires two separate physical/cloud host instances with configured network routes; automated single-host loopback test harness verified).
