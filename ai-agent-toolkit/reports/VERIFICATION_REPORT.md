# Verification report (2026-10-09)

Environment: macOS 26.6 (Darwin 25.6), git 2.45, node 24.18, python 3.14 (+3.12), uv 0.12.24 (installed by bootstrap), jq 1.7.1.

## Automated results (real runs)
| Suite | Result |
|---|---|
| `tests/test-manifest.sh` | -- test-manifest.sh: 66 passed, 0 failed |
| `tests/test-skill-discovery.sh` | -- test-skill-discovery.sh: 10 passed, 0 failed |
| `tests/test-installation.sh` | -- test-installation.sh: 20 passed, 0 failed |
| `scripts/verify-installation.sh --project /nonexistent` | summary: 92 passed, 0 failed, 7 warnings (warnings are expected: no agent was registered in that path) |
| `bash -n` on all scripts; `py_compile` on lib | pass |

## Requirement checklist
1. Folder structure: pass (verify: all required files present, scripts executable).
2. Every manifest entry validated: pass (66 manifest checks: fields, status honesty, files exist).
3. All 30 requested repos represented: pass (test-manifest per-repo checks).
4. Downloadable resources exist where installed: pass (27 retrieved with files + `.source.json`).
5. Skill frontmatter: pass (134 indexed skills all have name+description; 9 toolkit names equal folder names).
6. Three test suites run: pass (above).
7. Website lookup ("design a modern marketing website with react and tailwind" -> website-builder): pass.
8. Coding/debugging lookup ("fix react hydration bug in checkout page" -> coding-and-debugging): pass after a ranking fix (see below).
9. Browser/security lookups -> browser-automation / security-review: pass.
10. Irrelevant skills not loaded: pass (search returns <=3 of 134; strix/pentest skills not returned for a frontend query).
11. Rerun safety: pass in temp project (second install writes nothing; locally edited skill preserved; unmanaged skill untouched on uninstall; entry block written once; existing AGENTS.md content kept; backup created; `bootstrap.sh --no-download` regenerates an identical index). Real `bootstrap.sh` rerun also skipped all existing repos.
12. Portability: pass (toolkit copied to a temp project, search ran there; no `/Users/` paths in scripts, skills, config, agents, guides, README/QUICKSTART/MANIFEST; no symlinks).

## Agent discovery (live checks on this machine, temp project with skills installed)
| Agent | Check | Result |
|---|---|---|
| OpenCode | `opencode debug skill` | lists all 9 toolkit skills from `.opencode/skills` (strong evidence) |
| Claude Code | `claude -p "Is a skill named skill-scout available? yes/no"` | "Yes" (model self-report) |
| Antigravity | `agy -p` same question, skills in `.agents/skills` | "Yes" (model self-report) |
| Kilo Code | not installed here | **not tested**; files and docs-verified paths only |
Instruction-file blocks were tested for file correctness only, not for whether each agent obeys them.

## Other real checks
- `browser-harness --doctor`: version 0.1.13 (latest), Chrome running, **daemon alive FAIL, 0 browser connections** (remote debugging not enabled yet). Recording preference: `off (default)` = not yet decided.
- `npx ctx7@latest library "Next.js" ...`: returned `/vercel/next.js`.
- `update-toolkit.sh` dry run: 2 pointer repos had moved upstream within minutes of fetching (anythingmcp, appwrite); others current.
- `audit-repositories.sh`: all 30 URLs reachable; pipe-to-shell patterns flagged in 7 retained files (README/skill docs; not executed).

## Problems found and fixed during verification
- Symlink inside browser-harness upstream copy -> test failed; fetch now dereferences symlinks (`rsync -L`) and the file was replaced by a real copy.
- Search ranked third-party React skills above `coding-and-debugging` for a React bug query; added a toolkit-skill bonus when query and skill categories overlap.
- `audit-repositories.sh` reported every license file as missing (an `ls` with a non-matching glob returned non-zero); fixed, now reports 5 genuinely missing (3 pointer-only repos + 2 repos with no LICENSE upstream).
- `setup-agent.sh`: originally also wrote an Antigravity `.agents/rules` file whose path is not confirmed by Google's docs; removed. OpenCode now writes into CLAUDE.md when only that exists (OpenCode reads only the first of AGENTS.md/CLAUDE.md).

## Not tested
Kilo Code loading; Antigravity/Claude Code/OpenCode *following* the entry instruction on a real task; MCP registration commands (documented only); `update-toolkit.sh --apply` on real data (dry run only); `install-skills.sh --scope global` (never run, to protect your global config); cloud browser; token savings (not measured, no claim made).
