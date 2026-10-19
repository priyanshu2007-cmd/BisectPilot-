---
name: security-review
description: Review a codebase or configuration for security issues - dependencies, secrets, config, input validation, authentication/authorization and common web vulnerabilities (OWASP). Use for security audits, pre-release checks, and reviewing risky changes. Active testing only on systems the user is authorized to test.
license: MIT
---

# Security Review

## Scope first
Confirm what is in scope (repo path, local dev server). Static review of local code is always fine. Active testing (scanning, fuzzing, exploit attempts) needs: the user owns or is authorized to test the target, and it is `localhost`/staging or explicitly approved. No third-party sites.

## Checklist (read only relevant files)
1. **Secrets**: `rg -n -i "api[_-]?key|secret|token|password|BEGIN (RSA|PRIVATE)" --glob '!node_modules' --glob '!*.lock'`; check `.env*` is gitignored; check client bundles for server keys (`NEXT_PUBLIC_*`). Never print secret values; report file:line and the type only.
2. **Dependencies**: `npm audit --omit=dev` / `pip-audit` / `osv-scanner` if installed; note unmaintained or typosquat-looking packages; check lockfile exists.
3. **Input handling**: validation at every trust boundary (request bodies, query, headers, file uploads); parameterized queries; output encoding; SSRF-prone fetches; path traversal; deserialization.
4. **AuthN/AuthZ**: every route/action checks identity and ownership (IDOR); session cookies `HttpOnly; Secure; SameSite`; CSRF protection on state-changing requests; rate limiting on login/reset.
5. **Web config**: CSP, HSTS, `X-Content-Type-Options`, frame protections, CORS not `*` with credentials, no debug mode in production, safe error messages.
6. **Infra/CI**: least-privilege tokens, pinned CI actions, no secrets in logs, Docker not running as root.
7. **AI/agent surface** (if present): prompt-injection paths, tool permissions, untrusted content reaching privileged tools.

## Specialist material (read on demand)
`repositories/skills/VibeSec-Skill/SKILL.md` (secure-coding rules), `repositories/tools/strix/skills/` (OWASP/API testing guides; Strix itself is an autonomous pentester needing Docker and an LLM key; run only on authorized targets), `repositories/tools/is-website-vulnerable/README.md` (detects known-vulnerable JS libraries on a URL you own).

## Report
Findings ranked Critical/High/Medium/Low with file:line, impact, minimal fix, and how it was confirmed (read vs reproduced). List what was not checked. Fix only if asked, one finding per change.

## Boundaries
No exploitation beyond a minimal proof on authorized local targets. No destructive payloads, DoS, credential guessing, or mass scanning. Do not expose secrets in the report.
