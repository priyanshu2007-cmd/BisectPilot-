# Token optimization

The authoritative rules are in `skills/token-saver/SKILL.md`. Toolkit-level design choices that save tokens:
- Only 9 small skills are installed by default; descriptions are what an agent loads up front, so fewer installed skills = lower fixed overhead. Add sets (`--set core,web`) only for projects that need them.
- `MANIFEST.md` is about 30 lines; `skill-search.sh` returns at most the top N matches, so no agent has to read the 134 indexed skills.
- Large upstream repos are not stored whole (ECC 100MB -> 17 skills).

No percentage saving is claimed: it has not been measured. To measure: run the same task twice (with and without the toolkit) in a fresh session and compare the usage your agent reports (`/cost` in Claude Code, provider dashboards or per-message counters in the others). Record method and numbers in `local/`.
