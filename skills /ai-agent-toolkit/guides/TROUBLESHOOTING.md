# Troubleshooting

| Symptom | Fix |
|---|---|
| Agent never mentions skill-scout | Restart the session; confirm `<project>/.claude/skills/skill-scout` (or `.opencode/`, `.kilo/`, `.agents/skills`) exists; run `verify-installation.sh`. OpenCode: `opencode debug skill` lists what it sees. |
| `skill-search.sh` exits 3 | Index missing: `scripts/bootstrap.sh --no-download`. |
| `skill-search.sh` exits 1 | No match; rephrase with task nouns (e.g. "react", "security", "api"). |
| Bootstrap: `git clone` fails | Check network/proxy; rerun (finished repos are skipped); `--only NAME` retries one. |
| Skill skipped as "not toolkit-managed" | A skill of that name already exists in the target; rename or remove it yourself. |
| Skill skipped as "modified locally" | Intended; `--force` replaces it and keeps a `.bak.<ts>` copy. |
| OpenCode rejects a skill | Name must equal the folder and be <=64 chars lowercase-hyphen; description <=1024. `install-skills.sh` names folders by frontmatter name. |
| OpenCode ignores CLAUDE.md after adding AGENTS.md | It reads only the first of the two; `setup-agent.sh --agent opencode` writes into the one in use. |
| `browser-harness --doctor`: daemon alive FAIL | In Chrome open `chrome://inspect/#remote-debugging`, tick "Allow remote debugging", rerun. macOS prompt: `browser-harness mac-approve` (needs Accessibility permission for the terminal app). |
| `uv` missing | `scripts/bootstrap.sh --install-prereqs` (Homebrew) or `brew install uv`. |
| Context7 quota error | `npx ctx7@latest login` or set `CONTEXT7_API_KEY`. |
