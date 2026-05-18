# Configuration

Tagline reads an optional `.release-agent.md` file from the root of each repo it operates on. The file is **plain Markdown** — not YAML, not JSON — so you can write release operating notes in the same place as machine-readable settings.

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

Two section headings have deterministic parsers; everything else is treated as free-form context for the AI prompt.

### `## Branches`

A bulleted list of `- key: value` pairs. Recognized keys:

| Key | Default | What it does |
|-----|---------|--------------|
| `production` | `main` | The branch reports run against by default. |
| `staging` | `staging` | Pre-release branch for `-rc.N` tags. Set to `none` to disable. |
| `development` | `develop` | Pre-release branch for `-alpha.N` tags. Set to `none` to disable. |

### `## Pre-release Tags`

| Key | Default | What it does |
|-----|---------|--------------|
| `staging suffix` | `rc` | Suffix used on the staging branch (e.g. `1.5.0-rc.0`). |
| `development suffix` | `alpha` | Suffix used on the dev branch (e.g. `1.5.0-alpha.0`). |

### `## Versioning`

Declares which versioning scheme your repo uses. **Default is `semver`** — omit this section entirely if that's what you want.

```markdown
## Versioning

- scheme: calver
- pattern: YYYY.0M.MICRO
```

| Key | Default | Allowed values |
|-----|---------|----------------|
| `scheme` | `semver` | `semver`, `calver`, `incremental` |
| `pattern` | `YYYY.0M.MICRO` (when `scheme: calver`) | any combination of the tokens below + literal separators |

#### Calver tokens

| Token | Meaning | Example (May 19 2026) |
|-------|---------|----------------------|
| `YYYY` | 4-digit year | `2026` |
| `YY` | year mod 100, no padding | `26` |
| `0Y` | year mod 100, zero-padded to 2 digits | `26` |
| `MM` | month, no padding | `5` |
| `0M` | month, zero-padded | `05` |
| `DD` | day of month, no padding | `19` |
| `0D` | day of month, zero-padded | `19` |
| `MICRO` | counter that resets when any other token changes value, increments otherwise | `0`, `1`, `2`, … |

The pattern **must include `MICRO`** so two releases on the same date can be distinguished. Anything that isn't a token is treated as a literal — `YYYY.0M.MICRO`, `YYYY-MM-DD-MICRO`, and `vYYYY_0M_MICRO` all work.

Time tokens are evaluated in **UTC** so bot and action agree on the calendar regardless of where they run.

#### Scheme behavior at a glance

| Scheme | `/approve` does what | `/approve patch\|minor\|major` | `/approve as X.Y.Z` |
|--------|---------------------|--------------------------------|----------------------|
| `semver` | bump per conventional commits | force the bump category | force the exact version |
| `calver` | recompute from pattern + today | rejected with a usage hint | force the exact version |
| `incremental` | trailing integer + 1 | rejected with a usage hint | force the exact version |

For calver and incremental, the AI report's reasoning summarizes the release's *scope* rather than justifying a bump category — the version is mechanical.

## Sections forwarded to the AI

Any section that isn't one of the above is concatenated verbatim and passed to the AI in the report-generation prompt. Use this for:

- **`## Release Notes Style`** — set the tone. "Concise, technical." "Friendly with emoji." "Match this past release: …".
- **`## Scope Notes`** — explain what counts as user-facing in your repo. The AI uses this to reason about bump severity.
- Anything else — Tagline just hands it to the model.

## Defaults when there's no config

| Setting | Default |
|---------|---------|
| Production branch | `main` |
| Staging branch | `staging` |
| Dev branch | `develop` |
| Staging suffix | `rc` |
| Dev suffix | `alpha` |
| Versioning scheme | `semver` (semver math on conventional commits) |
| Release notes style | "Write clear, concise release notes for a developer audience." |

If you don't release from staging or develop, just leave the defaults alone — Tagline only looks for PRs on the branch you're generating a report for.

## Environment variables (bot-host)

These are set on the bot server, not in the repo. If you use the hosted instance, they're already configured for you.

| Var | Required | Default |
|-----|----------|---------|
| `APP_ID` | yes | — |
| `PRIVATE_KEY` | yes | — |
| `WEBHOOK_SECRET` | yes | — |
| `AI_API_KEY` | optional* | — |
| `AI_BASE_URL` | no | `https://openrouter.ai/api/v1` |
| `AI_MODEL` | no | `openai/gpt-4o-mini` |
| `PORT` | no | `3000` |
| `LOG_LEVEL` | no | `info` |

*If `AI_API_KEY` is absent, Tagline falls back to deterministic reports generated from commits alone.
