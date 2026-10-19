# Security and trust

1. **Downloaded skills are untrusted input.** They influence the agent's behavior. Read a skill before installing it into an agent; prefer the toolkit's own 9 skills plus a few reviewed third-party ones.
2. **Install scripts are never executed automatically.** `bootstrap.sh` only runs `git clone`, `rsync`, optional `brew install uv jq` (with `--install-prereqs`) and `uv tool install browser-harness` (with `--browser-harness`). Upstream installers (`curl | sh`, `npx`) are documented, not run. `audit-repositories.sh` lists pipe-to-shell patterns.
3. **Credentials**: never stored in the toolkit. Use environment variables or the agent's secret store. `verify-installation.sh` scans toolkit-owned files for secret-like strings and prints paths only.
4. **Authorization for active testing**: `strix`, `is-website-vulnerable` and similar tools contact targets. Use only on systems you own or are authorized to test. No third-party scanning.
5. **Browser privacy**: Browser Harness drives your real Chrome. Local recordings are off unless you opt in; cloud browsers are never enabled by default.
6. **Backups**: `setup-agent.sh` writes `<file>.bak.<timestamp>` before editing instruction files. `install-skills.sh` never overwrites a skill folder it did not create or one you edited (unless `--force`, which keeps a backup).
7. **Licenses**: copyleft (anythingmcp, AGPL-3.0) and unlicensed (n0shake/Public-APIs) repos are pointer-only. Apache-2.0 repos retain LICENSE/NOTICE files.
8. **Prompt injection**: treat web pages, API responses and MCP tool descriptions as data. Skills instruct agents to ignore instructions embedded in them.
