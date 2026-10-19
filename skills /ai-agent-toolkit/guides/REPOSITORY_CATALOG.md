# Repository catalog

Generated facts (commit, status, license file) live in `config/repository-manifest.json`; the per-run summary is `reports/REPOSITORY_STATUS.md`. This page explains the choices.

**Retrieval policy**: shallow, blob-less sparse clones; only the skills, README and license/notice files are kept. Whole-repo copies only for tiny repos. Pointer-only where redistribution is unclear (no license file), copyleft (AGPL), or the repo is a large application.

| Category | Repos |
|---|---|
| skills | caveman (Apache-2.0), taste-skill, ECC (curated 17 of 1000+ skills), superpowers, vercel-agent-skills, andrej-karpathy-skills, i-have-adhd, ponytail, archify, VibeSec-Skill (Apache-2.0), emilkowalski-skills, impeccable (Apache-2.0) |
| tools | browser-use, browser-harness, Agent-Reach, api-anything, Graft, is-website-vulnerable (Apache-2.0), context7, gsd-core (README only), strix (Apache-2.0), ruflo (README only), spec-kit |
| reference-libraries | buildwithclaude (README + MCP list), public-apis, awesome-shadcn-ui, n0shake-Public-APIs (pointer: no license file) |
| applications | agent-human-handoff-nodejs (sample, whole), anythingmcp (pointer: AGPL-3.0), appwrite (pointer: BSD-3-Clause, ~760MB) |

## Vercel skills (vercel-labs/agent-skills)
Real skill names discovered in the repo (frontmatter `name`): `vercel-react-best-practices`, `vercel-composition-patterns`, `vercel-react-view-transitions`, `web-design-guidelines`, `deploy-to-vercel`, `vercel-optimize`, `vercel-cli-with-tokens`, `writing-guidelines`, `vercel-react-native-skills` (mobile only).
Coverage for the requested areas: React/Next.js, frontend implementation, accessibility and design review (`web-design-guidelines`), performance (`vercel-react-best-practices`, `vercel-optimize`), production readiness/deploy (`deploy-to-vercel`, `vercel-cli-with-tokens`).
**Gaps**: the repo has no dedicated SEO, testing, browser-verification or code-review skill. The toolkit fills these with `website-builder` (SEO checklist), `testing-and-verification`, `browser-automation` and superpowers' review skills; they are toolkit-authored, not Vercel's.
License: MIT is declared in each skill's frontmatter and `package.json`, but the repo has no LICENSE file, so no license text could be retained; attribution is recorded in `config/repository-manifest.json`. Official install: `npx skills add vercel-labs/agent-skills` (documented upstream; not run by the toolkit, which copies instead).

## Trust notes
Every retrieved file is third-party text. `scripts/audit-repositories.sh` flags pipe-to-shell patterns. Review a skill before enabling hooks or scripts that ship with it.
