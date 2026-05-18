# Slash commands

Tagline is driven entirely by slash commands posted as comments on **any** issue in your repo. There's no dashboard.

Every command requires the commenter to have at least **write** access to the repo (`write`, `maintain`, or `admin`). Comments from bots are ignored to prevent loops.

## `/release-report`

Generate a release report for the production branch.

```
/release-report                  # default branch (from .release-agent.md)
/release-report --branch staging # report for a non-default branch
```

The bot replies with:

- **Header** — last tag + date, target branch, PR/commit/contributor counts.
- **Sections** — PRs grouped by `feat`, `fix`, and `chore` with ticket references.
- **Recommendation** — suggested semver bump (`patch`/`minor`/`major`) with 2–3 sentences of AI reasoning.
- **Changelog preview** — collapsible Keep-a-Changelog formatted block.
- **Approval footer** — the `/approve` commands available.

If no PRs have merged since the last tag, the bot replies with `No changes detected since vX.Y.Z` and posts nothing else.

If the AI provider is unavailable, the report is still generated deterministically from commits; reasoning reads `"AI unavailable — manual review required"`.

## `/approve [bump] [--draft] [--dry-run]`

Trigger a release.

| Form | Effect |
|------|--------|
| `/approve` | Use the bump Tagline suggested in the last report. |
| `/approve patch` | Force a patch bump. |
| `/approve minor` | Force a minor bump. |
| `/approve major` | Force a major bump. |
| `/approve --draft` | Create the GitHub release as a draft. |
| `/approve --dry-run` | Simulate everything; post a diff preview but make no changes. |
| `/approve minor --draft` | Combine flags freely. |

On approval, the bot:

1. Re-fetches PRs (in case anything merged since the last report).
2. Builds a `ReleasePlan` and dispatches `release-agent.yml` via `workflow_dispatch`.
3. Edits the acknowledgement comment to link to the workflow run.

The action does the actual writes in your CI environment: bumps `package.json`, prepends `CHANGELOG.md`, commits with `[skip ci]`, creates and pushes the `vX.Y.Z` tag, publishes the GitHub release, and opens a PR from `release/vX.Y.Z` to your production branch. When done, it posts a completion comment on the same issue.

### Error cases

- `release-agent.yml` is missing → bot replies with the file you need to add.
- The actor lacks write access → bot replies asking them to ask someone with write access.
- The bump argument is invalid → bot replies with the usage line.
- Tag already exists → action fails with `Tag vX.Y.Z already exists. Has this release already been triggered?`

## Comment lifecycle

`/release-report` and `/approve` follow the same pattern:

1. Bot posts an acknowledgement immediately so you know it's working.
2. Bot **edits** that same comment in-place once the result is ready (the report, or the dispatch link).

You won't see a tangle of comments per command — just one comment per command, edited to its final form.
