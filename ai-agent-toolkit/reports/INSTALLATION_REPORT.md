# Installation report (2026-10-09)

## Downloaded
- 27 repositories retrieved selectively into `repositories/<category>/<name>/` (19M total instead of ~1.5GB for full clones), each with `.source.json` (commit, timestamp) and `.checksums`.
- 3 pointer-only: n0shake/Public-APIs (no license), HelpCode-ai/anythingmcp (AGPL-3.0), appwrite/appwrite (BSD-3, ~760MB).
- 125 third-party skills indexed from 20 repositories; 9 toolkit skills written.
- Vercel official skills (9) retrieved from vercel-labs/agent-skills; gaps (SEO, testing, browser verification, code review) are covered by toolkit-authored skills, see `guides/REPOSITORY_CATALOG.md`.

## Installed / configured on this machine
- Homebrew `uv` 0.12.24 (was missing) via `bootstrap.sh --install-prereqs`.
- `browser-harness` 0.1.13 via `uv tool install --python 3.12 --upgrade --force browser-harness`; skill generated into `repositories/tools/browser-harness/generated/SKILL.md`.
- **Nothing in your global agent config was modified.** Agent skill/instruction installs were only done in temporary projects that were deleted afterwards.

## Agent status
| Agent | Status |
|---|---|
| Claude Code | Prepared. Discovery confirmed in a temp project. Not configured in your projects yet. |
| OpenCode | Prepared. Discovery confirmed via `opencode debug skill` in a temp project. Not configured in your projects yet. |
| Antigravity | Prepared. CLI answered yes in a temp project; instruction-file convention unverified; global path varies by version. |
| Kilo Code | Prepared only (files + docs-verified paths). Not installed here, untested. |
To configure a project: `ai-agent-toolkit/scripts/setup-agent.sh --agent <agent> --install-skills`.

## Requires manual action
1. Chrome: open `chrome://inspect/#remote-debugging`, tick "Allow remote debugging for this browser instance", then `browser-harness --doctor` (macOS may also need `browser-harness mac-approve` + Accessibility permission).
2. Browser recordings: choose `browser-harness recordings enable` or `disable` (currently undecided; nothing was enabled).
3. Optional credentials: `CONTEXT7_API_KEY`, Browser Use key (cloud), LLM key for strix. None were requested or stored.
4. Decide on adding the 3 pointer-only repos yourself (licenses/size).

## Not done on purpose
No MCP servers registered, no Vercel/Appwrite deployment, no scanning of any website, no upstream installers (`curl | sh`, `npx skills add`) executed.
