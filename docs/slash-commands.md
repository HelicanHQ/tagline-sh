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
- **Changelog preview** — collapsible Keep-a-Changelog formatted block (the technical changelog, for developers).
- **Plain-language summary** — collapsible block with a headline, body, and 2–5 highlights in user-facing language (the release notes, for non-developers). One AI call produces both this and the changelog.
- **Approval footer** — the `/approve` commands available.

If no PRs have merged since the last tag, the bot replies with `No changes detected since vX.Y.Z` and posts nothing else.

If the AI provider is unavailable, the report is still generated deterministically from commits; reasoning reads `"AI unavailable — manual review required"` and the plain-language summary degrades to a minimal shape (`v1.5.0 includes N updates`) — the section is always present, only the prose quality varies.

## `/approve [bump] [--draft] [--dry-run]`

Trigger a release.

| Form | Effect |
|------|--------|
| `/approve` | Use the version Tagline suggested in the last report. |
| `/approve patch` | Force a patch bump. *(semver only — see below)* |
| `/approve minor` | Force a minor bump. *(semver only)* |
| `/approve major` | Force a major bump. *(semver only)* |
| `/approve as 2026.6.0` | Force an exact version. Works on every scheme. |
| `/approve --draft` | Create the GitHub release as a draft. |
| `/approve --dry-run` | Simulate everything; post a diff preview but make no changes. |
| `/approve minor --draft` | Combine flags freely. |
| `/approve as 2026.6.0 --dry-run` | `as` combines with flags too. |

`patch` / `minor` / `major` are only meaningful when your `.release-agent.md` declares `scheme: semver` (the default). On a calver or incremental repo, Tagline rejects them with a usage hint and asks you to use `/approve` or `/approve as <version>` instead — see [configuration / Versioning](./configuration.md).

On approval, the bot:

1. Re-fetches PRs (in case anything merged since the last report).
2. Builds a `ReleasePlan` — carrying forward the plain-language summary you previewed — and dispatches `release-agent.yml` via `workflow_dispatch`.
3. Edits the acknowledgement comment to link to the workflow run.

The action does the writes in your CI environment, in two phases:

**Phase A (propose, on `workflow_dispatch`):** bumps `package.json`, prepends `CHANGELOG.md`, commits with `[skip ci]`, pushes a `release/vX.Y.Z` branch, and opens a PR back to your production branch. The PR body carries the plain-language summary, the technical changelog, and a hidden machine-readable plan marker that Phase B reads. **No tag is created. No GitHub Release is published.** The acknowledgement comment is updated with a `Preview (will publish on merge)` block, framing the release as a proposal.

**Phase B (finalize, on `pull_request: closed`):** when you merge the release PR, the action runs again — this time triggered by the merge event. It parses the plan marker out of the PR body, creates the tag at the *merge commit* (so it lands on `main`, not on an orphan branch), publishes the GitHub Release (with the plain-language summary above the technical changelog), and comments on the merged PR with a **Ready to share** block — the summary formatted for direct paste into Slack, email, or any product-changelog tool. Closing the PR without merging cancels the release entirely.

### Error cases

- `release-agent.yml` is missing → bot replies with the file you need to add.
- The actor lacks write access → bot replies asking them to ask someone with write access.
- The bump argument is invalid → bot replies with the usage line.
- A bump word (`patch`/`minor`/`major`) used on a non-semver repo → bot replies explaining the active scheme and the alternatives (`/approve` or `/approve as <version>`).
- Tag already exists when Phase B runs → action logs `Reference already exists` for that tag and skips it idempotently. Re-running the workflow on the same merge SHA is safe.
- Phase B logs `could not find the embedded plan marker in the release PR body` → the release PR body was edited by hand or the PR wasn't opened by Tagline. Phase B refuses to tag/release rather than guess. Re-run Phase A by closing the PR and starting a new `/approve`.
- Action logs `Resource not accessible by integration` → your workflow `permissions:` block is missing one of `contents: write`, `pull-requests: write`, or `issues: write`. See [Required workflow permissions](./getting-started.md#required-workflow-permissions). If the failure is *specifically* on the acknowledgement comment, Phase A still succeeded — the bot just couldn't post the courtesy comment.
- Action logs `GitHub Actions is not permitted to create or approve pull requests` → separate from `permissions:`. Enable the toggle at *Settings → Actions → General → Workflow permissions → "Allow GitHub Actions to create and approve pull requests"* (and the same setting at org level if your repo lives in an org). Phase A pushes the release branch even if the PR open fails — the acknowledgement comment now includes a direct `compare` URL to open the missing PR by hand. Once that PR is merged, Phase B finalizes normally.

## Comment lifecycle

`/release-report` and `/approve` follow the same pattern:

1. Bot posts an acknowledgement immediately so you know it's working.
2. Bot **edits** that same comment in-place once the result is ready (the report, or the dispatch link).

You won't see a tangle of comments per command — just one comment per command, edited to its final form.
