# Monorepo & Multi-Package Workspace Bisection

### Monorepo Package Scoping (`--cwd` and `--scope`)

When bisecting a regression inside a monorepo package:

```bash
# Automatically scopes git bisect to packages/api plus root lockfiles/manifests
bisectpilot plan --config bisectpilot.config.json --cwd packages/api
bisectpilot start --config bisectpilot.config.json --cwd packages/api --yes

# Explicitly restrict additional relative paths
bisectpilot start --config bisectpilot.config.json --cwd packages/api --scope packages/api,packages/shared --yes
```

- When `--cwd <pkg>` is set without an explicit `--scope`, BisectPilot automatically passes `-- <pkg>` plus existing root dependency/workspace manifests (`package.json`, `package-lock.json`, `pnpm-lock.json`, `pnpm-workspace.yaml`, `yarn.lock`, `bun.lockb`, `lerna.json`, `turbo.json`, `nx.json`, `.nvmrc`, `.node-version`, `tsconfig.json`) to `git bisect start`.
- If `git bisect` checks out a historical commit where the `--cwd` directory did not yet exist, BisectPilot classifies that commit as `skip` (`untestable_revision`) rather than failing.
- SHA-256 hashes of root and package manifests are recorded in each ledger event.
