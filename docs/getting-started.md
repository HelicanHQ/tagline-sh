# Getting started

Tagline is a GitHub-native release-management agent. It reads merged PRs since the last release tag, generates a human-readable report with an AI-reasoned version bump suggestion, and — once you approve with a slash command — executes the release end-to-end.

This guide gets you from zero to a real release in about five minutes.

## What you'll set up

1. The **Tagline GitHub App** installed on a repo.
2. The **release-agent.yml workflow** in your repo.
3. One **repo secret** (`AI_API_KEY`) for the AI provider.
4. Optionally, a `.release-agent.md` config file.

## Step 1 — install the GitHub App

Install **Tagline** on the repo you want to release. Use either:

- The hosted instance at `https://github.com/apps/tagline-sh` (free for OSS repos), or
- A self-hosted instance — see [self-hosting](./self-hosting.md).

When the app is installed it opens a welcome issue with a setup checklist.

## Step 2 — add the workflow

Copy [`examples/single-repo/.github/workflows/release-agent.yml`](../examples/single-repo/.github/workflows/release-agent.yml) to your repo at the same path. For monorepos, use the [`monorepo` example](../examples/monorepo/.github/workflows/release-agent.yml) — the logic is identical; Tagline detects your monorepo flavor automatically.

This workflow is only invoked via `workflow_dispatch`, triggered by the bot when you `/approve`. It never runs on its own.

### Required workflow permissions

The workflow's `permissions:` block must grant exactly three things — these scope the `GITHUB_TOKEN` the action uses inside the run, and are separate from the GitHub App's own permissions:

```yaml
permissions:
    contents: write          # commit version bumps, push the release branch + tag, create the GitHub release
    pull-requests: write     # open the changelog PR back to the production branch
    issues: write            # post the completion comment on the originating issue
```

The example workflow files already include these. If you build your own workflow and see `Resource not accessible by integration` in the Actions log, you're missing one of the three — most commonly `issues: write`.

## Step 3 — set the AI secret

Tagline calls an **OpenAI-compatible** endpoint for the report's reasoning. Any provider works — OpenAI, OpenRouter, Anthropic via proxy, Groq, Ollama.

Set the following repo or org secret:

| Secret | Required? | Default |
|--------|-----------|---------|
| `AI_API_KEY` | yes | — |
| `AI_BASE_URL` | no | `https://openrouter.ai/api/v1` |
| `AI_MODEL` | no | `openai/gpt-4o-mini` |

If `AI_API_KEY` is unset, Tagline falls back to a deterministic report generated from your commit history with `reasoning: "AI unavailable — manual review required"`.

## Step 4 — optional config

Drop a [`.release-agent.md`](./configuration.md) file in the repo root to customize tracked branches, pre-release suffixes, and release-notes tone. Without one, Tagline defaults to `main` / `staging` / `develop`.

## Step 5 — your first release

On any issue (including the welcome issue), comment:

```
/release-report
```

The bot replies with a formatted report: PRs grouped by type, suggested bump, AI reasoning, and a changelog preview. Review it.

When ready, comment:

```
/approve            # use the suggested bump
/approve minor      # override the bump
/approve --dry-run  # simulate, no changes
/approve --draft    # create as a draft release
```

Tagline kicks off the workflow. When it finishes, it posts a completion comment on the same issue with links to the new tag, GitHub release, and changelog PR.

That's it.

## Two changelogs from one approval

Every release produces **two** artifacts, both AI-written in the same call:

1. **A technical `CHANGELOG.md`** — conventional-commits-derived, grouped by `### Added` / `### Fixed` / `### Changed`. For developers and git history.
2. **A plain-language summary** — one headline sentence, a 2–4 sentence body, and 2–5 highlight bullets. No PR numbers, no commit types. For product owners, customers, teammates in non-engineering roles.

The summary appears in three places:

- **The report comment** — collapsible "Plain-language summary" section, so you can review it before approving.
- **The GitHub release body** — pinned above the technical changelog so anyone browsing the Releases page sees the readable version first.
- **The completion comment** — under a "Ready to share" header. Copy this block into Slack, email, or your product changelog tool with zero editing.

If your AI provider is unavailable, the summary degrades gracefully to a minimal deterministic shape (`{N} updates since {last-tag}` with highlights drawn from PR titles). The section is always there; only the prose quality varies.

## Next steps

- [Slash commands reference](./slash-commands.md)
- [Configuration reference](./configuration.md)
- [Monorepo behavior](./monorepo.md)
- [Self-hosting](./self-hosting.md)
