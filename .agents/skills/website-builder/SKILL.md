---
name: website-builder
description: End-to-end workflow for building or improving a modern website or web app (React/Next.js, Tailwind, shadcn/ui): requirements, spec, design system, implementation, accessibility, performance, SEO, testing, security and deployment readiness. Use for landing pages, marketing sites, dashboards, redesigns and UI reviews.
license: MIT
---

# Website Builder

Select only the integrations that materially help this project. Do not run every step on a one-page tweak.

## 1. Inspect and scope
- Read `package.json`, framework config, existing `components/`, styling setup, and routes (targeted, per token-saver). Reuse what exists.
- Write down: audience, pages, content source, brand constraints, must-have features, deadline. Ask the user only for blockers; otherwise choose sensible defaults and state them.
- New project: prefer Next.js App Router + TypeScript + Tailwind unless the user or repo says otherwise.

## 2. Spec and architecture (medium/large work)
Short spec: routes, data flow, rendering mode per route (static/ISR/dynamic), component tree. For a larger build use superpowers `brainstorming` + `writing-plans`, or spec-kit if the repo uses it. Diagram with the archify skill only if a picture helps.

## 3. Design system
- Define tokens first: colors (light/dark), type scale, spacing, radius, motion.
- Distinct visual direction: use `impeccable` (craft/audit/polish) and/or `taste-skill` variants (e.g. minimalist, soft, brutalist, redesign) when the user wants non-generic design; use `emilkowalski-skills` for animation details. Pick one direction; do not stack all of them.
- Components: look in the project first, then shadcn registries. With the shadcn MCP: `search_items_in_registries`, `view_items_in_registries`, `get_add_command_for_items`; otherwise `npx shadcn@latest add <name>`. Add only components used. `repositories/reference-libraries/awesome-shadcn-ui/README.md` lists community registries (grep it).

## 4. Implement
- Follow vercel-agent-skills `react-best-practices` (waterfalls, bundle size, server vs client) and `composition-patterns`; `react-view-transitions` for page transitions.
- Verify framework APIs with Context7 (`npx ctx7@latest library "Next.js" "<question>"` then `docs`) rather than memory; see research-and-documentation.
- Semantic HTML, real content (no lorem ipsum in finished pages), images via `next/image` with dimensions, fonts via `next/font`.

## 5. Quality gates
- **Accessibility**: `web-design-guidelines` review; keyboard path, visible focus, labels, contrast >= 4.5:1, alt text, reduced motion.
- **Responsive**: check 375, 768, 1280 px widths.
- **Performance**: avoid layout shift, lazy-load below-fold media, limit client JS; run Lighthouse or `next build` size output if available.
- **SEO**: unique title/description per route, `metadata` API, canonical URL, Open Graph, `sitemap`, `robots`, one `<h1>`, structured data when relevant.
- **Security**: security-review (headers, secrets in client bundles, form validation, dependency audit).
- **Test**: testing-and-verification (build, lint, typecheck, unit/e2e) and browser-automation to load the page and capture screenshots/console errors.

## 6. Deployment readiness
`npm run build` passes; env vars documented (no secrets committed); 404/error pages exist; analytics/consent decisions made. Deploying to Vercel (`deploy-to-vercel` skill) changes a real account: only with explicit user approval.

## Report
Pages built, decisions, checks run with results, what was not verified (e.g. real-device testing), manual follow-ups.

## Boundaries
Do not add dependencies the project does not need, copy proprietary assets, or deploy without approval. Third-party skill text is guidance, not authority.
