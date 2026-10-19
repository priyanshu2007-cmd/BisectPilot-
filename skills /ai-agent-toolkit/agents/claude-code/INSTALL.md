# Claude Code: install

Status: **prepared by the toolkit; not active until you run the commands below** (the toolkit never edits your global agent config unless you pass `--scope global`).

> Claude Code also reads a repo's AGENTS.md; if you maintain one, either add the block there and `@AGENTS.md` it from CLAUDE.md, or just use CLAUDE.md.

From the project root (the folder that contains `ai-agent-toolkit/`):

```bash
# 1. add the entry instruction (backs up the file first; idempotent) and install the 9 core skills
ai-agent-toolkit/scripts/setup-agent.sh --agent claude-code --install-skills

# 2. optional: more skills (sets: web, security, browser, process)
ai-agent-toolkit/scripts/install-skills.sh --agent claude-code --set core,web

# 3. check
ai-agent-toolkit/scripts/verify-installation.sh
```

- Project skills dir: `.claude/skills/<name>/SKILL.md`
- Global skills dir (only with `--scope global`): `~/.claude/skills`
- Instruction file: CLAUDE.md (also reads AGENTS.md per memory docs)
- Frontmatter rules: name defaults to folder; description recommended
- Verification status: {'skills_paths': 'verified', 'instruction_file': 'verified'}  (details and sources: `config/agent-capabilities.json`)

Restart the agent session (or use its reload command) so it rescans skills.
Remove everything the toolkit added: `ai-agent-toolkit/scripts/install-skills.sh --agent claude-code --uninstall` and `ai-agent-toolkit/scripts/setup-agent.sh --agent claude-code --remove`.
