# Session Recovery & Evidence Reports

## Session Recovery and Evidence Reports

### Session Artifacts

Every session directory (`.bisectpilot/sessions/<sessionId>/`) stores:

- `ledger.jsonl`: Append-only, SHA-256 hash-chained write-ahead log of all session events.
- `manifest.json`: Current `SessionManifestV1` snapshot.
- `checkpoint.json` & `checkpoint.backup.json`: Checksummed recovery snapshots written via temporary file + `fsyncSync` + atomic rename (and directory `fsyncSync` on POSIX).
- `report.json`, `report.md`, `report.html`, `repro.sh`: Automatically written when a session concludes.

### Inspecting and Resuming Interrupted Sessions

If a bisection process is killed (for example, `SIGKILL` or terminal closure):

```bash
# 1. Inspect the session; detects stale locks from dead PIDs and reports state: "needs_recovery"
bisectpilot status <sessionId>

# 2. Resume the session; reuses cached classifications from checkpoint/WAL without re-running tests
bisectpilot resume <sessionId>
```

- **Durability scope:** Process crashes (`SIGKILL` / abrupt process exit) are crash-consistent via atomic rename, backup checkpoint fallback, and `ledger.jsonl` replay. OS crashes and sudden hardware power loss are best-effort via POSIX file/directory `fsyncSync`; if underlying storage hardware drops unflushed writes, recovery falls back to `checkpoint.backup.json` or `ledger.jsonl` and fails closed if the hash chain is damaged.

### Generating and Verifying Reports

```bash
# Print Markdown report to stdout (or save with --out) while verifying the ledger hash chain
bisectpilot report <sessionId> --verify --out report.md

# Export structured JSON report and verify hash chain integrity
bisectpilot report <sessionId> --json --verify --out report.json

# Generate standalone offline HTML report (zero external network/CDN requests)
bisectpilot report <sessionId> --html --out report.html

# Append a GitHub Actions Markdown summary to $GITHUB_STEP_SUMMARY or a target file
bisectpilot report <sessionId> --github-summary summary.md

# Export copy-paste Markdown for a GitHub Issue or Pull Request
bisectpilot report <sessionId> --github-issue --out issue.md
```

See [`docs/architecture.md`](docs/architecture.md) for details on the ledger and checkpoint architecture.

---

