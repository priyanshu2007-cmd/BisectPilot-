---
name: token-saver
description: Reduce unnecessary input and output tokens without hurting correctness. Use at the start of work in large repos, before reading many files, when command output is large, when context grows long, or when the user asks for concise or low-cost operation.
license: MIT
---

# Token Saver

Goal: same quality, fewer tokens. Never trade away tests, security checks or correctness.

## Rules
1. **Skills**: never read all skills; use `scripts/skill-search.sh` and read 1-3.
2. **Explore narrow-to-wide**: project manifest (`package.json`, `pyproject.toml`) -> directory listing at depth 1-2 -> targeted search -> read the matched range.
3. **Search before read**: `rg -n "symbol" path` then read ±40 lines (`sed -n 'A,Bp'` or the Read tool's offset/limit). Use a code-graph tool (e.g. Graft) when available.
4. **Bound output**: pipe through `head -50`, `tail -40`, `wc -l`, `rg -c`. For logs, grep for `error|fail|warn` first. Never `cat` lockfiles, minified bundles, `node_modules`, build output, or whole repos.
5. **Summarize large artifacts once**: write a 5-10 line note to `local/notes-<topic>.md` and reuse it; revalidate only if the file changed (`git diff --stat`, mtime).
6. **Do not repeat work**: do not re-read unchanged files, re-run identical searches, or re-research settled facts.
7. **Reuse the project**: existing components, helpers and installed dependencies before adding new ones.
8. **Tool calls**: batch independent calls in parallel; spawn subagents only for work that is truly parallel or too large for the main context.
9. **Tests**: run the targeted test (file or `-k` name) first; run the full suite once before finishing if the change is cross-cutting.
10. **Output**: short, technically complete final report: what changed, how verified, what remains. No restating the request, no long tutorials unless asked. If the user asks for direct execution, execute.
11. **Context carry-over**: keep decisions, file paths, commands and open issues; drop transcripts and raw dumps.

## Measuring (only with real data)
- Claude Code: `/cost` or `/context` shows session usage; the API returns `usage.input_tokens/output_tokens` per call.
- OpenCode / Kilo Code / Antigravity: use the provider usage view or per-message token counters if the UI exposes them.
- Measure the same task with and without the toolkit and report both numbers with the method. If no reliable counter exists, say "not measured". Do not state a percentage saving without such measurements.

## Boundaries
Do not skip reading code you must change, skip security-relevant files, or truncate output so far that failures are hidden. When output was truncated, say so.
