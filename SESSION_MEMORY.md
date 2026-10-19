# SESSION MEMORY

Use this file for temporary task-specific context.

It prevents `AI_BRAIN.md` from becoming bloated.

## Current Goal

Implement the selected `website-builder` skill as a complete BisectPilot website in
`website/`, with a tested local build and deployment documentation.

## Files Opened

- `AI_RULES.md`, `AI_BRAIN.md`, `AGENTS.md`, `CLAUDE.md`
- `ai-agent-toolkit/skills/skill-scout/SKILL.md`
- `ai-agent-toolkit/skills/website-builder/SKILL.md`
- `website/package.json`, app routes, `components/PilotConsole.tsx`, and project config

## Findings

- No existing application or product brief was present, so the website assumes
  BisectPilot is a developer tool for tracing AI agent regressions.
- The chosen direction is a dark laboratory field-notes interface with a static
  landing page and a deterministic client-side replay specimen.

## Changes Made

- Added `website/` with Next.js 16 App Router, React 19, TypeScript, Tailwind CSS v4,
  responsive design tokens, `/`, `/docs`, metadata, SEO endpoints, error states,
  security response headers, and `PilotConsole` interactions.
- Added reproducibility files: `.nvmrc`, `package-lock.json`, `.env.example`,
  `Dockerfile`, `Makefile`, and `README.md`.

## Tests / Validation

- Passed: `npm test` from `website/` (typecheck, ESLint, production build).
- Passed: HTTP smoke checks for `/`, `/docs`, `/robots.txt`, and `/sitemap.xml`.
- Passed: `npm audit --omit=dev` (0 production vulnerabilities) and header smoke check.
- Untested: Playwright browser smoke test because Python `playwright` is not installed.
- Untested: Docker build because the local Docker daemon is not running.

## Remaining Work

- If browser-level QA is required, install/use the project Playwright MCP or a local
  Python Playwright environment and run the smoke script in the temporary agent path.
- Replace deterministic sample data with the real BisectPilot API when its contract exists.

## Temporary Notes

- No external credentials or runtime services are required for the current website.
- Durable summary moved to `AI_BRAIN.md`.
