# Maintainer Release & Publishing Guide

This document outlines the step-by-step instructions for releasing and publishing **BisectPilot** to npm and GitHub Packages.

> **CRITICAL**: Do NOT execute publication without maintainer review and authorization.

---

## 1. Package Name Decision

BisectPilot is currently configured as `@priyanshu2007-cmd/bisectpilot` in `package.json` for scoped distribution on GitHub Packages and npm.

- The unscoped package name **`bisectpilot`** is currently **available** on the public npm registry (verified via `npm view bisectpilot` returning 404).
- If publishing unscoped as `bisectpilot`, update the `"name"` field in `package.json` to `"bisectpilot"` and ensure `publishConfig.access` is set to `"public"`.
- If publishing scoped under an organization or user scope, retain `@priyanshu2007-cmd/bisectpilot` or update to the desired organization name.

---

## 2. Secrets & Permissions Setup

Ensure the following GitHub Actions secrets are configured in repository settings (`Settings -> Secrets and variables -> Actions`):

- **`NPM_TOKEN`**: Granular Access Token or classic automation token from [npmjs.com](https://www.npmjs.com) with publish rights.
- **`GITHUB_TOKEN`**: Provided automatically by GitHub Actions with `packages: write` permissions.

---

## 3. Pre-Release Verification Checklist

Run all local checks to confirm complete build, typecheck, and test green status:

```bash
npm run build
npm run typecheck
npm test
npm run test:py
git diff --check
```

Verify tarball packaging without publishing:

```bash
npm pack --dry-run
```

---

## 4. Release Execution Steps

When ready to publish a new release:

1. **Bump Version**:
   Update `version` in `package.json` following semantic versioning:
   ```bash
   npm version 0.1.0 --no-git-tag-version
   ```
2. **Update CHANGELOG**:
   Move items from `## [Unreleased]` to the new version heading `## [0.1.0] - YYYY-MM-DD`.
3. **Commit & Tag**:
   ```bash
   git commit -am "chore(release): v0.1.0"
   git tag -a v0.1.0 -m "Release v0.1.0"
   ```
4. **Push Release Tag**:
   ```bash
   git push origin main --tags
   ```
5. **Monitor GitHub Actions**:
   The workflow at `.github/workflows/publish.yml` will automatically trigger on tag push `v*`, execute the full test suite and packaging checks, and publish to the target registry with build provenance.
