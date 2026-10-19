# ai-agent-toolkit

A portable folder of skills, scripts and reference material for AI coding agents (Claude Code, OpenCode, Antigravity, Kilo Code). Copy it into any project; the agent then finds and reads only the skills a task needs.

## What is inside
| Path | Purpose |
|---|---|
| `skills/` | 9 original workflow skills: `skill-scout` (router), `token-saver`, `website-builder`, `coding-and-debugging`, `research-and-documentation`, `browser-automation`, `security-review`, `testing-and-verification`, `api-and-mcp-integration` |
| `repositories/` | Real files from 67 upstream repos (selectively retrieved; large or unlicensed ones are pointer-only), with their licenses and `.source.json` (commit, date) |
| `config/` | `sources.json` (catalog, hand-edited), `repository-manifest.json` and `skill-index.json` (generated from disk), `install-sets.json`, `agent-capabilities.json` |
| `scripts/` | `bootstrap`, `install-skills`, `setup-agent`, `update-toolkit`, `verify-installation`, `audit-repositories`, `skill-search` |
| `agents/` | Per-agent install notes and ready-to-copy entry instructions |
| `guides/` | Installation, catalog, security, MCP, troubleshooting, updating |
| `tests/`, `reports/`, `local/` | Test scripts; generated reports; private scratch space |

## Use it in a project
```bash
cp -R ai-agent-toolkit /path/to/project/
cd /path/to/project
ai-agent-toolkit/scripts/setup-agent.sh --agent claude-code --install-skills   # or opencode | kilo-code | antigravity
```
Nothing global is touched unless you pass `--scope global`. See `QUICKSTART.md` and `guides/COMPLETE_INSTALLATION_GUIDE.md`.

## Design rules
- **Lightweight**: only 9 skills are installed into an agent by default, so per-session skill-description overhead stays small. `skill-scout` finds the rest through `scripts/skill-search.sh`.
- **Portable**: no symlinks, no absolute paths; everything resolves relative to the toolkit folder.
- **Honest status**: manifests are generated from what is on disk; a repo is "retrieved" only if files exist.
- **Untrusted content**: downloaded skills are guidance, never authority (`guides/SECURITY.md`).

## Licenses
Retrieved repositories keep their own license files and notices inside `repositories/<category>/<name>/`. See `guides/REPOSITORY_CATALOG.md`. The toolkit's own files (skills, scripts, guides) are MIT.
