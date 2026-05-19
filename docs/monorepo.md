# Monorepo support

Tagline auto-detects monorepos and versions **each package independently** — Changesets-style "one PR, many tags." Drop the workflow file in, run `/release-report`, and a per-package table appears showing what would ship.

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

**Each package gets its own version math, derived from only the PRs that affected it.** A `feat` in `packages/api` bumps `packages/api`'s minor; it doesn't touch `packages/ui`. The user's killer example: release webapp + api today, but leave the database alone — Tagline does that automatically because the database has no attributed PRs.

The math is per-package for every versioning scheme (semver, calver, incremental):

| Scheme | Per-package behavior |
|---|---|
| `semver` | AI suggests `patch`/`minor`/`major` per package from each package's own conventional commits. |
| `calver` | Each package has its own `MICRO` counter. `api@2026.5.0` and `webapp@2026.4.0` can release the same day and become `api@2026.5.1`, `webapp@2026.5.0` independently. |
| `incremental` | Each package has its own trailing integer; `+1` per package release. |

## What the action does

For a monorepo release event, the action:

1. **Bumps `version` in each affected package's `package.json`** — to that package's own `nextVersion`, not a shared string.
2. **Prepends a per-package CHANGELOG entry** to each affected package's `CHANGELOG.md`, containing only that package's attributed PRs.
3. **Prepends a release-event aggregator** to the root `CHANGELOG.md`, listing each package's name + version + a deep-link to its own CHANGELOG.
4. **Pushes one annotated tag per package** using Changesets convention:
   - `@acme/api@1.5.0` for scoped packages
   - `api@1.5.0` for unscoped packages
5. **Opens one PR** from `release/vevent-YYYY-MM-DD` → production branch, containing all the bumps and CHANGELOG writes.
6. **Posts a completion comment** with the per-package tag list and the "Ready to share" plain-language summary.

Failure mode worth knowing: if **any** package's tag already exists, the action refuses the entire release rather than partially shipping. A half-released monorepo is worse than a failed release.

## Per-package overrides at approval time

The AI suggests bumps per package, but you can override:

```
/approve api:minor ui:patch
```

Each `name:bump` token overrides one package's bump. Packages not mentioned use the AI suggestion. Packages with no attributed PRs are excluded entirely (they can't be released via an override unless you also write commits touching them).

Rules:
- Only `patch` / `minor` / `major` work as the bump half — and only when the repo's `versioning.scheme` is `semver`. CalVer / Incremental are mechanical.
- Names must match the `name` field in the package's `package.json` exactly (including any `@scope/` prefix). Typos are rejected with a helpful list of valid names.
- You can't combine `/approve minor` (global) with `name:bump` (per-package) — pick one shape.
- `--draft` and `--dry-run` flags work with both shapes.

## Examples

**Ship two of three packages** (database has no attributed PRs):

```
/release-report
# bot replies with a table showing only api and webapp
/approve
# both ship at AI-suggested bumps; database is untouched
```

**Override one package's bump**:

```
/approve api:major ui:patch
# api gets a major bump; ui gets a patch; any other affected packages
# use the AI suggestion.
```

**Force a dry run on a specific override mix**:

```
/approve api:minor --dry-run
```

## Single-repo vs. monorepo

| Concern | Single-repo | Monorepo |
|---|---|---|
| Tag | One `vX.Y.Z` | One per package: `@scope/name@X.Y.Z` |
| CHANGELOG | `<root>/CHANGELOG.md` | `<package>/CHANGELOG.md` per package + `<root>/CHANGELOG.md` aggregator |
| Approval grammar | `/approve patch\|minor\|major` or `/approve as X.Y.Z` | `/approve` or `/approve name:bump …` |
| Release-event ID | The version itself | A date string `event-YYYY-MM-DD` (used for the release branch only) |
| GitHub Release page | One per release | One per release event (aggregates the package list) |

## What changes in the workflow file

Nothing. The [`examples/monorepo`](../examples/monorepo/.github/workflows/release-agent.yml) workflow is byte-identical to the single-repo one. All monorepo detection happens at runtime.

## Limitations to flag

- **No `exclude` flag** to permanently skip a package — the attribution-based exclusion (no PRs ⇒ no release) is the only mechanism. If you need to skip a package that does have PRs, omit it from any `name:bump` override list when the AI table would otherwise include it.
- **Cross-package version coupling is not enforced.** If your monorepo requires `@acme/api` and `@acme/types` to ship in lockstep, you have to remember to bump both yourself. (A future "release groups" feature would address this; not in scope today.)
- **Pre-release suffixes apply uniformly per branch.** If you release from `staging`, every package's `nextVersion` gets the staging suffix (`-rc.0`). There's no way to release one package from staging and another from production in the same event.
