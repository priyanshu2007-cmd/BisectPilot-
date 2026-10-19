# OpenCode: install

Status: **prepared by the toolkit; not active until you run the commands below** (the toolkit never edits your global agent config unless you pass `--scope global`).

> OpenCode reads `AGENTS.md` first and `CLAUDE.md` only if no `AGENTS.md` exists. `setup-agent.sh` respects this: it writes into the file OpenCode will actually read.

From the project root (the folder that contains `ai-agent-toolkit/`):

```bash
# 1. add the entry instruction (backs up the file first; idempotent) and install the 9 core skills
ai-agent-toolkit/scripts/setup-agent.sh --agent opencode --install-skills

# 2. optional: more skills (sets: web, security, browser, process)
ai-agent-toolkit/scripts/install-skills.sh --agent opencode --set core,web

# 3. check
ai-agent-toolkit/scripts/verify-installation.sh
```

- Project skills dir: `.opencode/skills, .claude/skills, .agents/skills`
- Global skills dir (only with `--scope global`): `~/.config/opencode/skills`
- Instruction file: AGENTS.md, else CLAUDE.md (first found wins); extra files via 'instructions' in opencode.json
- Frontmatter rules: name (must equal folder, <=64, lowercase-hyphen) + description (<=1024) required
- Verification status: {'skills_paths': 'verified', 'instruction_file': 'verified'}  (details and sources: `config/agent-capabilities.json`)

Restart the agent session (or use its reload command) so it rescans skills.
Remove everything the toolkit added: `ai-agent-toolkit/scripts/install-skills.sh --agent opencode --uninstall` and `ai-agent-toolkit/scripts/setup-agent.sh --agent opencode --remove`.
