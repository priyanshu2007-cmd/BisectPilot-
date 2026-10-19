# Updating

```bash
scripts/update-toolkit.sh            # dry run: lists repos whose upstream HEAD moved and a short diff
scripts/update-toolkit.sh --apply    # copies new files in; files you edited locally are kept
scripts/update-toolkit.sh --only superpowers --apply
scripts/audit-repositories.sh        # URL/license/risk report -> reports/REPOSITORY_AUDIT.md
scripts/install-skills.sh --agent all   # refresh installed copies (skips ones you edited)
```
Local edits are detected by `.checksums` in each repo folder. Upstream-deleted files are never removed automatically. After updating, `build_config.py` regenerates `MANIFEST.md`, `skill-index.json` and `repository-manifest.json`. Browser Harness: `uv tool install --python 3.12 --upgrade --force browser-harness` (or `browser-harness --update -y`).
