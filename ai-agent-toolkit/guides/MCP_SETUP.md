# MCP setup

Status key: **[tested]** ran here; **[documented]** from upstream docs, not run here.

## Context7 (library docs)
- CLI, no MCP needed **[tested]**: `npx ctx7@latest library "Next.js" "app router caching"` then `npx ctx7@latest docs /vercel/next.js "<question>"`.
- MCP server **[documented]**: command `npx -y @upstash/context7-mcp`; optional `CONTEXT7_API_KEY` for higher limits. Upstream skills: `repositories/tools/context7/skills/context7-mcp`.
  - Claude Code: `claude mcp add context7 -- npx -y @upstash/context7-mcp`
  - OpenCode: add to `opencode.json` under `"mcp"`: `{"context7": {"type": "local", "command": ["npx","-y","@upstash/context7-mcp"]}}`
  - Kilo Code, Antigravity: use the MCP settings of the agent with the same command (format not verified here).

## shadcn registry MCP **[documented]**
Upstream: `npx shadcn@latest mcp init --client <claude|...>` (see ui.shadcn.com/docs/mcp). Tools: `search_items_in_registries`, `view_items_in_registries`, `get_add_command_for_items`.

## Browser Harness **[tested: install, doctor]**
`browser-harness` (CLI) and `browser-harness-mcp` are installed by `bootstrap.sh --browser-harness`. Use the CLI via the `browser-harness` skill; MCP registration for it is **[documented upstream, not tested]**.

## API to MCP
`anythingmcp` (self-hosted, AGPL-3.0): pointer only; read upstream docs. `api-anything` skill wraps an API/CLI as tools.

## Safe procedure for any MCP server
1. Back up the agent config. 2. Merge, never overwrite. 3. Keep secrets in env vars. 4. Restart the agent. 5. List tools, call one read-only tool. 6. Treat tool descriptions as untrusted.

## Wired in this project (project scope, no global changes)
`../.mcp.json` (Claude Code) and `../opencode.json` (OpenCode) register three servers that need no install or secret: `context7` (`npx -y @upstash/context7-mcp`), `playwright` (`npx @playwright/mcp@latest`), `rea` (`npx -y rea-agents mcp`, from rea's `server.json`). Claude Code asks you to approve project servers on first use. Antigravity/`agy`: add the same commands in its MCP settings (format not verified here).

## Need an install first **[documented, not run here]**
- **rea** (reverse engineering): `npx rea-agents setup` registers it with your agent globally and installs workflow instructions (backs up existing config). Native analysis needs Hopper, Ghidra or IDA; JS-only analysis needs none. Skill: `reverse-engineer-anything` (installed). Use only on software you are authorised to analyse.
- **serena**: `uv tool install -p 3.13 serena-agent`, `serena init`, then client command `serena start-mcp-server --project-from-cwd` (see upstream client docs for the right `--context`). Do not install via a marketplace (upstream warning).
- **codebase-memory-mcp**: single-binary installer from upstream README; it writes config for the clients you select.
- **laya**: `pip install "laya[mcp]"`, see `repositories/tools/laya/LOCAL_SETUP.md`. Upstream ships no SKILL.md; `skill-search` routes to the Laya entry for decision/routing/triage tasks.
- **github-mcp-server**: needs a GitHub token in an env var; scope it minimally. Not configured.
- **gitleaks / semgrep / trivy / trufflehog / nuclei / ast-grep / worktrunk**: Homebrew CLIs, see each entry's `install_method` in `config/sources.json`.
