---
name: testing-and-verification
description: Choose and run the right level of tests and checks (lint, typecheck, unit, integration, e2e, build, manual browser check) and report real results as passed, failed, skipped or untested. Use before claiming any change works, when adding tests, or when asked to verify.
license: MIT
---

# Testing and Verification

## Pick the level
| Change | Minimum |
|---|---|
| Pure function / bug fix | targeted unit test (regression test first) |
| Shared module / API | related test files + typecheck + lint |
| UI change | component/e2e test or browser check (browser-automation) + build |
| Config / build / deps | clean build + full suite |
| Docs / comments | link and command sanity only |

## Workflow
1. Find the project's commands (`package.json` scripts, `Makefile`, `pyproject.toml`, CI config). Use them; do not invent.
2. Run targeted first (`npm test -- path`, `pytest path -k name`), then widen. Run each command for real and read the exit code and tail of output (`| tail -40`).
3. A bug fix needs a test that fails before and passes after. New logic with branches needs at least one test.
4. If a check cannot run (missing deps, no browser, no credentials), try the fallback, otherwise mark it **untested** with the reason. Do not fake it.
5. Flaky result: rerun once, report both outcomes.

## Reporting format
```
passed:   <command> (N tests)
failed:   <command> - <first failing test + message>
skipped:  <what, why>
untested: <what, why>
```
Include exact commands. Never write "all tests pass" unless the full suite ran and passed. Delegate completion claims to superpowers `verification-before-completion` if available.

## Boundaries
Do not delete, skip, or loosen tests to get green. Do not mock the thing under test. Use temp directories/test databases for destructive tests, never real data.
