# Monorepo support

Tagline auto-detects monorepos and versions each package independently. No configuration required — drop the workflow file in, run `/release-report`, and per-package bumps appear.

## Supported flavors

Detection priority (first match wins):

1. **pnpm workspaces** — `pnpm-workspace.yaml`
2. **Turborepo** — `turbo.json` (packages from `package.json#workspaces`)
3. **Nx** — `nx.json` (`projects` field, or `apps/*` + `libs/*` defaults)
4. **Lerna** — `lerna.json`
5. **npm / yarn workspaces** — `package.json#workspaces` (yarn detected via `packageManager: yarn@…`)
6. **None** — falls back to single-repo mode.

## How packages get versioned

For each merged PR, Tagline asks GitHub which files it changed. A PR that touches `packages/api/src/auth.ts` is attributed to the `api` package. A PR that touches multiple packages is attributed to all of them.

Each package's suggested bump is computed independently using only the PRs that affected it. A `feat` in `packages/api` does **not** bump `packages/ui`.

When the action runs, it:

- Bumps `version` in each affected package's `package.json`.
- Prepends a new entry to each affected package's `CHANGELOG.md`.
- Also prepends the **aggregate** entry to the root `CHANGELOG.md`.
- Creates a single `vX.Y.Z` tag and GitHub release covering the whole release. (Per-package tags are out of scope for the MVP.)

## Single shared version vs. independent versions

The MVP uses a **single shared version** (all packages move together). Independent versioning per package — where `packages/api` could be at `2.3.0` while `packages/ui` is at `0.9.1` — is on the roadmap but not in scope yet.

If your monorepo already has independent versions in `package.json`, Tagline reads each `currentVersion` correctly but the action will rewrite each to the same `nextVersion`. If that's a problem for your workflow, hold off until independent versioning lands.

## Disabling a package

Add a `## Scope Notes` section to `.release-agent.md` that mentions the package. The AI will use that context when reasoning about the report, but Tagline doesn't have a hard `exclude` flag yet — `## Scope Notes` is the documented escape hatch for now.

## What changes in the workflow file

Nothing. The [`examples/monorepo`](../examples/monorepo/.github/workflows/release-agent.yml) workflow is byte-identical to the single-repo one. All monorepo detection happens in the action at runtime.
