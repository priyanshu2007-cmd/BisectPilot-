# Kilo Code: install

Status: **prepared by the toolkit; not active until you run the commands below** (the toolkit never edits your global agent config unless you pass `--scope global`).

> Kilo reads `.agents/skills` by default and `.claude/skills` only if Claude Code compatibility is on, so the native `.kilo/skills` target is used.

From the project root (the folder that contains `ai-agent-toolkit/`):

```bash
# 1. add the entry instruction (backs up the file first; idempotent) and install the 9 core skills
ai-agent-toolkit/scripts/setup-agent.sh --agent kilo-code --install-skills

# 2. optional: more skills (sets: web, security, browser, process)
ai-agent-toolkit/scripts/install-skills.sh --agent kilo-code --set core,web

# 3. check
ai-agent-toolkit/scripts/verify-installation.sh
```

- Project skills dir: `.kilo/skills, .agents/skills (.claude/skills only with Claude Code compatibility enabled)`
- Global skills dir (only with `--scope global`): `~/.kilo/skills`
- Instruction file: AGENTS.md at project root (AGENT.md fallback)
- Frontmatter rules: name + description required (name <=64, lowercase-hyphen; docs inconsistent on folder match, so keep them equal)
- Verification status: {'skills_paths': 'verified', 'instruction_file': 'verified'}  (details and sources: `config/agent-capabilities.json`)

Restart the agent session (or use its reload command) so it rescans skills.
Remove everything the toolkit added: `ai-agent-toolkit/scripts/install-skills.sh --agent kilo-code --uninstall` and `ai-agent-toolkit/scripts/setup-agent.sh --agent kilo-code --remove`.
