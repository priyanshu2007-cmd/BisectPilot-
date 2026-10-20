# BisectPilot website

BisectPilot is a focused landing page and interactive replay specimen for an AI
regression-analysis product. It is designed for engineers who need to trace a
behavior change back to the first turn where two runs stopped agreeing.

## Product scope

- **Audience:** engineers and evaluation teams shipping AI agents.
- **Primary job:** make the first meaningful divergence visible without losing the
  prompt, model, tool, and timing context around it.
- **Routes:**
  - `/` — marketing page with the interactive replay console.
  - `/explorer` — standalone replay workspace supporting CLI JSON report uploads (`bisectpilot report <id> --json`) and exported runs.
  - `/docs` — crawlable explanation of the compare → walk → handoff workflow.
  - `/sitemap.xml` and `/robots.txt` — generated SEO endpoints.
- **Rendering:** static server-rendered App Router pages, with the replay console as
  a small client component for filtering, tab changes, replay, and copy feedback.
- **Data:** deterministic sample data and client-side CLI report importation; no external API or secret is required.

## Design direction

The visual language is a dark laboratory field notebook rather than a generic SaaS
dashboard: graphite paper, signal-lime markers, orange divergence warnings, and a
serif display face that gives the technical copy a human voice. The single memorable
element is the orbit-like hero graphic; the rest of the page stays quiet and useful.

## Requirements

- Node.js `24.18.0` (pinned in `.nvmrc`).
- npm 11+.

## Setup

```bash
cd website
npm ci
cp .env.example .env.local
```

`NEXT_PUBLIC_SITE_URL` is optional and defaults to `http://localhost:3000`.

The site does not need the root engine to render its sample data, but building a
fresh CLI report lets you verify the import path end to end:

```bash
cd ..
npm ci
npm run build
node dist/src/index.js report <sessionId> --json --out website/public/example-report.json
cd website
```

Only import reports from repositories and sessions you are authorized to share.
The explorer validates the report shape before displaying it; it does not upload
the file to a server.

## Run locally

```bash
npm run dev
```

Open <http://localhost:3000>. The docs page is at <http://localhost:3000/docs>.

## Checks

The single reproducible check command is:

```bash
npm test
```

It runs, in order:

1. `npm run typecheck` — strict TypeScript validation.
2. `npm run lint` — Next.js ESLint rules.
3. `npm run build` — production App Router build.

The checks do not call external APIs and can be rerun offline after dependencies
have been installed with `npm ci`.

For a manual browser check, confirm that:

1. `/` renders the landing page and replay console.
2. `/explorer` can switch replay tabs, filter events, and show copy feedback.
3. The report-import control accepts a valid local JSON report and rejects an
   invalid shape without crashing the page.
4. `/docs`, `/sitemap.xml`, and `/robots.txt` load successfully.
5. Browser developer tools show no unexpected console errors or external API
   requests.

If Python Playwright or an equivalent browser harness is unavailable, the
production build still verifies static rendering, type safety, and lint rules;
interactive behavior remains an explicit manual or browser-harness check.

For a production-style local run:

```bash
npm run build
npm run start
```

## Docker

```bash
docker build -t bisectpilot-website .
docker run --rm -p 3000:3000 bisectpilot-website
```

The image uses Next.js standalone output and runs as a non-root user.

## Deploy

The site is compatible with any Node.js 24 host that can run `npm ci`, `npm run
build`, and `npm run start`. Set `NEXT_PUBLIC_SITE_URL` to the public HTTPS URL so
canonical metadata, `robots.txt`, and `sitemap.xml` use the deployed origin.

No deployment command is included because deployment changes a real account and
requires an explicit provider choice and approval.

## Website debugging checklist

- Start with `npm run typecheck`, then `npm run lint`, then `npm run build`.
- Check the browser console and the route that reproduces the issue.
- For imported reports, validate the JSON shape and use a small fixture before
  trying a large session artifact.
- Keep `NEXT_PUBLIC_SITE_URL` limited to the public origin; never place private
  keys in `NEXT_PUBLIC_*` variables because they are client-visible.
