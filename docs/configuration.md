# Configuration

Tagline reads an optional `.release-agent.md` file from the root of each repo it operates on. The file is **plain Markdown**. Not YAML, not JSON, so you can write release operating notes in the same place as machine-readable settings.

## File format

```markdown
# Tagline Configuration

## Branches

- production: main
- staging: staging
- development: develop

## Pre-release Tags

- staging suffix: rc
- development suffix: alpha

## Release Notes Style

Write release notes for a technical audience. Be concise.
Group under: New Features, Bug Fixes, Maintenance.

## Scope Notes

This is a Node.js API service. Changes to `src/` affect the public API.
The `packages/ui` package has its own release cycle.
```

## Sections Tagline parses

These section headings have deterministic parsers; everything else is treated as free-form context for the AI prompt.

### `## Channels` (recommended)

A release **channel** maps one branch to a stability tier. Tagline watches every channel branch: a PR merged into a channel branch opens that channel's own release-tracking issue, and the version it ships carries the channel's pre-release suffix.

```markdown
## Channels

- main: stable
- staging: rc
- develop: alpha
```

Each line is `- <branch>: <tier>`. `stable` produces clean versions (`0.2.0`); any other value is a **pre-release** channel whose label becomes the suffix — so `rc` → `0.2.0-rc.N`, `alpha` → `0.2.0-alpha.N`, and you can add your own (`beta`, `canary`, …). Branch names are case-sensitive; tiers are not.

**How versions flow (dev → staging → prod):** the base is anchored to the last **stable** release and stays fixed as you promote; only the suffix and counter change. The counter is derived from existing tags, so it resets automatically when the base bumps or you switch channels:

```
last stable 0.1.1, a feat lands →
  merge → develop   0.2.0-alpha.0 → 0.2.0-alpha.1   (counter climbs)
  promote → staging 0.2.0-rc.0    → 0.2.0-rc.1       (same base, counter resets)
  promote → main    0.2.0                            (stable, suffix dropped)
```

> Pre-release suffixes use unpadded numeric counters (`alpha.0`, `alpha.1`) so every channel version is valid npm/SemVer.

### `## Branches` + `## Pre-release Tags` (legacy shorthand)

If you don't declare `## Channels`, Tagline derives channels from these older sections — `production` → stable, `staging` → its suffix, `development` → its suffix. Existing repos keep working unchanged.

`## Branches` — a bulleted list of `- key: value` pairs:

| Key           | Default   | What it does                                                      |
| ------------- | --------- | ----------------------------------------------------------------- |
| `production`  | `main`    | The stable channel; the branch reports run against by default.    |
| `staging`     | `staging` | Pre-release branch for `-rc.N` tags. Set to `none` to disable.    |
| `development` | `develop` | Pre-release branch for `-alpha.N` tags. Set to `none` to disable. |

`## Pre-release Tags`:

| Key                  | Default | What it does                                           |
| -------------------- | ------- | ------------------------------------------------------ |
| `staging suffix`     | `rc`    | Suffix used on the staging branch (e.g. `1.5.0-rc.0`). |
| `development suffix` | `alpha` | Suffix used on the dev branch (e.g. `1.5.0-alpha.0`).  |

> **Workflow note:** for Phase B (finalize) to tag pre-release releases, list every channel branch under `push.branches` in `.github/workflows/release-agent.yml` (e.g. `[main, staging, develop]`).

### `## Versioning`

Declares which versioning scheme your repo uses. **Default is `semver`**, omit this section entirely if that's what you want.

```markdown
## Versioning

- scheme: calver
- pattern: YYYY.MM.MICRO
```

| Key       | Default                                 | Allowed values                                           |
| --------- | --------------------------------------- | -------------------------------------------------------- |
| `scheme`  | `semver`                                | `semver`, `calver`, `incremental`                        |
| `pattern` | `YYYY.MM.MICRO` (when `scheme: calver`) | any combination of the tokens below + literal separators |

> ⚠️ **Use unpadded tokens (`MM`, `DD`) — npm rejects leading zeros.** SemVer (and therefore npm) forbids a leading zero in any numeric component, so a zero-padded token like `0M` produces an **invalid** version (`2026.06.0`) that `npm publish` refuses. Tagline now **fails the release with a clear error** the moment a pattern would emit one, rather than shipping a broken version. The padded `0X` tokens remain only for non-npm, tag-only workflows.

#### Calver tokens

| Token   | Meaning                                                                      | Example (May 19 2026) |
| ------- | ---------------------------------------------------------------------------- | --------------------- |
| `YYYY`  | 4-digit year                                                                 | `2026`                |
| `YY`    | year mod 100, no padding                                                     | `26`                  |
| `0Y`    | year mod 100, zero-padded to 2 digits ⚠️ npm-invalid for years < 2010        | `26`                  |
| `MM`    | month, no padding ✅ npm-safe                                                 | `5`                   |
| `0M`    | month, zero-padded ⚠️ npm-invalid in single-digit months (Jan–Sep)          | `05`                  |
| `DD`    | day of month, no padding ✅ npm-safe                                          | `19`                  |
| `0D`    | day of month, zero-padded ⚠️ npm-invalid on single-digit days               | `19`                  |
| `MICRO` | counter that resets when any other token changes value, increments otherwise | `0`, `1`, `2`, …      |

The pattern **must include `MICRO`** so two releases on the same date can be distinguished. Anything that isn't a token is treated as a literal — `YYYY.MM.MICRO`, `YYYY-MM-DD-MICRO`, and `vYYYY_MM_MICRO` all work.

Time tokens are evaluated in **UTC** so bot and action agree on the calendar regardless of where they run.

#### Scheme behavior at a glance

| Scheme        | `/approve` does what           | `/approve patch\|minor\|major` | `/approve as X.Y.Z`     |
| ------------- | ------------------------------ | ------------------------------ | ----------------------- |
| `semver`      | bump per conventional commits  | force the bump category        | force the exact version |
| `calver`      | recompute from pattern + today | rejected with a usage hint     | force the exact version |
| `incremental` | trailing integer + 1           | rejected with a usage hint     | force the exact version |

For calver and incremental, the AI report's reasoning summarizes the release's _scope_ rather than justifying a bump category — the version is mechanical.

## Sections forwarded to the AI

Any section that isn't one of the above is concatenated verbatim and passed to the AI in the report-generation prompt. Use this for:

- **`## Release Notes Style`** — set the tone. "Concise, technical." "Friendly with emoji." "Match this past release: …".
- **`## Scope Notes`** — explain what counts as user-facing in your repo. The AI uses this to reason about bump severity.
- Anything else — Tagline just hands it to the model.

## Defaults when there's no config

| Setting             | Default                                                        |
| ------------------- | -------------------------------------------------------------- |
| Production branch   | `main`                                                         |
| Staging branch      | `staging`                                                      |
| Dev branch          | `develop`                                                      |
| Staging suffix      | `rc`                                                           |
| Dev suffix          | `alpha`                                                        |
| Versioning scheme   | `semver` (semver math on conventional commits)                 |
| Release notes style | "Write clear, concise release notes for a developer audience." |

If you don't release from staging or develop, just leave the defaults alone — Tagline only looks for PRs on the branch you're generating a report for.

## Environment variables (bot-host)

These are set on the bot server, not in the repo. If you use the hosted instance, they're already configured for you.

| Var              | Required   | Default                        |
| ---------------- | ---------- | ------------------------------ |
| `APP_ID`         | yes        | —                              |
| `PRIVATE_KEY`    | yes        | —                              |
| `WEBHOOK_SECRET` | yes        | —                              |
| `AI_API_KEY`     | optional\* | —                              |
| `AI_BASE_URL`    | no         | `https://openrouter.ai/api/v1` |
| `AI_MODEL`       | no         | `openai/gpt-4o-mini`           |
| `PORT`           | no         | `3000`                         |
| `LOG_LEVEL`      | no         | `info`                         |

\*If `AI_API_KEY` is absent, Tagline falls back to deterministic reports generated from commits alone.
