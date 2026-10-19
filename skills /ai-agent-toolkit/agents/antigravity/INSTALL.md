# Antigravity (AGY): install

Status: **prepared by the toolkit; not active until you run the commands below** (the toolkit never edits your global agent config unless you pass `--scope global`).

> Antigravity: only the project skills path is verified. The instruction-file convention is unverified, so the skill-discovery route (step 2) is the one to rely on. Global paths differ between Antigravity IDE, 2.0 and CLI; check your install before using `--scope global`.

From the project root (the folder that contains `ai-agent-toolkit/`):

```bash
# 1. add the entry instruction (backs up the file first; idempotent) and install the 9 core skills
ai-agent-toolkit/scripts/setup-agent.sh --agent antigravity --install-skills

# 2. optional: more skills (sets: web, security, browser, process)
ai-agent-toolkit/scripts/install-skills.sh --agent antigravity --set core,web

# 3. check
ai-agent-toolkit/scripts/verify-installation.sh
```

- Project skills dir: `.agents/skills (older docs: .agent/skills)`
- Global skills dir (only with `--scope global`): `(version dependent, see config/agent-capabilities.json)`
- Instruction file: unverified (AGENTS.md/GEMINI.md and rules are not named in the skills codelab)
- Frontmatter rules: description mandatory; name optional (defaults to folder)
- Verification status: {'skills_paths': 'verified for project scope; global varies', 'instruction_file': 'unverified'}  (details and sources: `config/agent-capabilities.json`)

Restart the agent session (or use its reload command) so it rescans skills.
Remove everything the toolkit added: `ai-agent-toolkit/scripts/install-skills.sh --agent antigravity --uninstall` and `ai-agent-toolkit/scripts/setup-agent.sh --agent antigravity --remove`.
