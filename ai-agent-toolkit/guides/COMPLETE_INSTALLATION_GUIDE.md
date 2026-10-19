# Complete installation guide

Legend: **[tested]** = run on macOS 26 (Darwin 25.6) during construction; **[documented]** = from vendor docs, not run here.

## 1. Prerequisites
Required: `git`, `python3`, `jq`, `rsync` (all present on macOS with Xcode CLT; `jq` ships with recent macOS). Optional: `node`/`npm` (Context7 CLI, shadcn), `uv` + Python 3.12 (Browser Harness), Homebrew (for auto-install), Chrome (browser control).
```bash
scripts/bootstrap.sh --no-download      # reports what is missing  [tested]
scripts/bootstrap.sh --install-prereqs  # brew install of missing uv/jq/git/node/rsync only  [tested: installed uv]
```

## 2. Folder contents
See `README.md`. Generated files (do not edit): `MANIFEST.md`, `config/repository-manifest.json`, `config/skill-index.json`. Hand-edited: `config/sources.json`, `config/install-sets.json`.

## 3. Copy into a project
```bash
cp -R ai-agent-toolkit /path/to/project/     # real copy; no symlinks, no absolute paths  [tested in temp dir]
```
A project may also keep the toolkit elsewhere: set `AI_TOOLKIT_DIR=/path/to/ai-agent-toolkit` and `skill-scout` will find it.

## 4. Bootstrap
Only needed to (re)download resources or rebuild the index; a copied toolkit already contains them.
```bash
scripts/bootstrap.sh                    # skips repos already present; rebuilds MANIFEST/index  [tested]
scripts/bootstrap.sh --only superpowers # one repo
```
Exit codes: 0 ok, 3 prerequisite missing, 4 some downloads failed.

## 5. Install for each agent  (run from the project root)
```bash
ai-agent-toolkit/scripts/setup-agent.sh --agent claude-code --install-skills   # CLAUDE.md block + .claude/skills
ai-agent-toolkit/scripts/setup-agent.sh --agent opencode    --install-skills   # AGENTS.md (or CLAUDE.md) block + .opencode/skills
ai-agent-toolkit/scripts/setup-agent.sh --agent kilo-code   --install-skills   # AGENTS.md block + .kilo/skills
ai-agent-toolkit/scripts/setup-agent.sh --agent antigravity --install-skills   # AGENTS.md block + .agents/skills
ai-agent-toolkit/scripts/install-skills.sh --agent all --set core,web,browser  # shared layout: .claude/skills + .agents/skills
```
[tested in temp projects]. Discovery confirmed: OpenCode (`opencode debug skill` listed all 9), Claude Code and the Antigravity CLI (`agy -p`) reported `skill-scout` available. **Kilo Code is not installed on this machine: its files are prepared, not verified.**

## 6. Native skill discovery
Per-agent paths, frontmatter rules and sources are in `config/agent-capabilities.json` and `agents/<agent>/INSTALL.md`. Global installs (`--scope global`) change your user-level config and are never the default; Antigravity's global path varies by version, so check it first.

## 7. Context7 and other MCP
See `guides/MCP_SETUP.md`. Quick check **[tested]**: `npx ctx7@latest library "Next.js" "caching"`.

## 8. Browser automation (Browser Harness)
```bash
scripts/bootstrap.sh --no-download --browser-harness   # uv tool install --python 3.12 --upgrade --force browser-harness; generates its SKILL.md  [tested]
browser-harness --doctor                               # health check  [tested]
```
If `daemon alive` fails: in Chrome open `chrome://inspect/#remote-debugging`, tick "Allow remote debugging for this browser instance", rerun doctor; on macOS a per-connection Allow sheet may need `browser-harness mac-approve` (needs Accessibility permission for your terminal) **[documented]**. Recording preference: `browser-harness recordings`; the installer never enables it silently (default No) and keeps an existing preference. Cloud browsers need a Browser Use key and are not enabled.
Install the skill into agents: `scripts/install-skills.sh --agent <agent> --set core,browser`.

## 9. Credentials and permissions
No credentials are stored or required. Optional: `CONTEXT7_API_KEY`, Browser Use API key (cloud only), `LLM` keys for strix. Put them in your shell environment or the agent's secret store, never in the toolkit or the project repo.

## 10. Verify
```bash
scripts/verify-installation.sh                 # structure, JSON, 30 repos, skill metadata, secrets scan, registrations, CLIs  [tested]
tests/test-manifest.sh; tests/test-skill-discovery.sh; tests/test-installation.sh   # [tested]
```

## 11. Update
`guides/UPDATING.md`.

## 12. Troubleshoot
`guides/TROUBLESHOOTING.md`.

## 13. Uninstall toolkit-managed integrations
```bash
scripts/install-skills.sh --agent all --uninstall      # removes only folders with .toolkit-managed  [tested]
scripts/setup-agent.sh --agent claude-code --remove    # removes only the marked block; backup kept  [tested for opencode]
uv tool uninstall browser-harness                      # [documented]
```
Backups (`*.bak.<timestamp>`) are left for you to delete.
