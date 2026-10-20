# Daemon & Remote Worker Distributed Bisection

## Daemon and Remote Worker Setup

Ordinary single-machine CLI usage (`bisectpilot start`) does **not** require a daemon or worker. The daemon and worker commands are optional components for background queuing or coordinating workers across pre-provisioned repositories.

### Local Loopback Queue Workflow

By default, the daemon binds to `127.0.0.1:4317` over HTTP using a generated `0600` bearer token file in `.bisectpilot/daemon`:

```bash
# Start local daemon in background
bisectpilot daemon start --state-dir .bisectpilot/daemon

# Check daemon status and telemetry summary
bisectpilot daemon status --state-dir .bisectpilot/daemon

# Enqueue a consented bisection job (requires explicit goodRef, not "auto")
bisectpilot daemon enqueue --config bisectpilot.config.json --yes --state-dir .bisectpilot/daemon

# Start a local pull worker mapped to a pre-provisioned repository path
bisectpilot worker start \
  --state-dir .bisectpilot/worker \
  --server http://127.0.0.1:4317 \
  --token-file .bisectpilot/daemon/daemon.token \
  --repo default=/absolute/path/to/repo

# Stop worker and daemon cleanly
bisectpilot worker stop --state-dir .bisectpilot/worker
bisectpilot daemon stop --state-dir .bisectpilot/daemon
```

### Remote Mutual TLS (mTLS) Workflow

Binding the daemon to a non-loopback address requires HTTPS with server and CA certificates (`--tls-cert`, `--tls-key`, `--tls-ca`, `--tls-require-client-cert`), and remote workers refuse plaintext HTTP URLs. In mTLS mode, the daemon verifies the worker certificate's Subject Common Name (`CN`) against `--worker-id`, checks certificate SHA-256 fingerprints against `revocations.json` on every request, and enforces monotonic lease fencing tokens.

- Follow [`docs/multimachine-mtls-setup.md`](docs/multimachine-mtls-setup.md) for PKI generation, certificate SAN/CN rules, deployment commands, and certificate revocation (`bisectpilot daemon revoke`).
- **Verification note:** Mutual TLS handshakes, CN authorization, dynamic credential rotation, and fingerprint revocation are verified by automated loopback integration tests (`tests/integration/mtls-remote-worker.test.ts`), but deployment across separate physical hosts has not been independently verified in CI.

---
