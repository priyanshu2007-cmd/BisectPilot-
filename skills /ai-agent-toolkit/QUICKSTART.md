# Quickstart

1. Copy the folder into your project root: `cp -R /path/to/ai-agent-toolkit ./`
2. Register with your agent (pick one or run several):
   ```bash
   ai-agent-toolkit/scripts/setup-agent.sh --agent claude-code --install-skills
   ai-agent-toolkit/scripts/setup-agent.sh --agent opencode    --install-skills
   ai-agent-toolkit/scripts/setup-agent.sh --agent kilo-code   --install-skills
   ai-agent-toolkit/scripts/setup-agent.sh --agent antigravity --install-skills
   ```
3. Restart the agent session. Ask for a task; the agent should read `skill-scout` first.
4. Check: `ai-agent-toolkit/scripts/verify-installation.sh`
5. Try the lookup yourself: `ai-agent-toolkit/scripts/skill-search.sh "fix a react bug"`

If the folder was copied without `repositories/` content (e.g. trimmed), refresh it: `ai-agent-toolkit/scripts/bootstrap.sh`.
Optional browser control: `ai-agent-toolkit/scripts/bootstrap.sh --install-prereqs --browser-harness`, then follow `guides/COMPLETE_INSTALLATION_GUIDE.md` section 8.
