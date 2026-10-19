---
name: coding-and-debugging
description: Locate the root cause of a bug or failing test, make the smallest correct change, and verify it. Use for bug reports, stack traces, failing tests, regressions, unexpected behavior, and small feature changes in an existing codebase.
license: MIT
---

# Coding and Debugging

## Workflow
1. **Reproduce**: get the exact error, input, and command. Run the narrowest repro (one test, one request). If you cannot reproduce, say so before changing anything.
2. **Locate**: search from the symptom (`rg -n "error text|function"` or `grep -rn` if `rg` is missing), read only the relevant ranges, follow callers. Check recent changes (`git log -n 5 --stat -- <path>`, `git diff`).
3. **Hypothesize, then test**: state the suspected cause, confirm with a print/log/assertion or a failing test. Fix the root cause, not the symptom. For hard bugs use superpowers `systematic-debugging`; for new behavior use `test-driven-development`.
4. **Change minimally**: smallest diff that fixes the cause; match surrounding style; reuse existing helpers. Update all callers and tests the change touches (grep for them first). Keep validation and error handling intact.
5. **Verify**: re-run the repro (must now pass), then the related test file, then lint/typecheck, then the full suite if the change is shared code. Add a regression test for the bug.
6. **Report**: cause, fix (file:line), commands run with results, anything unverified.

## Framework specifics
Check current docs via Context7 before relying on remembered APIs (research-and-documentation). For React/Next issues also consult vercel-agent-skills `react-best-practices`.

## Boundaries
- Do not weaken or delete tests to make them pass. Do not disable lint/type rules or swallow errors to hide a failure.
- No unrelated refactors or dependency additions. Do not run destructive commands (reset, force-push, delete data) without approval.
- If two attempts fail, stop and report what was learned instead of guessing.
