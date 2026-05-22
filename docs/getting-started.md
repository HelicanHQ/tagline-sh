# Getting started

Tagline is a GitHub-native release-management agent. It reads merged PRs since the last release tag, generates a human-readable report with an AI-reasoned version bump suggestion, and once you approve with a slash command, executes the release end-to-end.

This guide gets you from zero to a real release in about five minutes.

## What you'll set up

1. The **Tagline GitHub App** installed on a repo.
2. The **release-agent.yml workflow** in your repo.
3. One **repo secret** (`AI_API_KEY`) for the AI provider.
4. A `.release-agent.md` config file is required

## Step 1 — install the GitHub App

Install **Tagline** on the repo you want to release. Use either:

- The hosted instance at `https://github.com/apps/tagline-sh` (free for OSS repos), or
- A self-hosted instance — see [self-hosting](./self-hosting.md).

When the app is installed it opens a **Configure Tagline** pull request on each repo. The PR adds a default `.release-agent.md` and the body explains the entire release flow with a copy-pasteable workflow YAML block. Merge it (after editing the config to taste) and you're set up. Slash commands posted on the Configure PR itself are ignored — the bot opens a dedicated **release-tracking issue** later, once the first feature PR merges (see Step 5).

## Step 2 — add the workflow

> [!NOTE]
> After installing the app, you'll see that the Configure Tagline PR already includes the workflow file and the `.release-agent.md` file. If you merge that PR, you can skip this step. If you want to set up the workflow yourself, copy the YAML block from the Configure PR body or from the example files linked below.

Copy [`examples/single-repo/.github/workflows/release-agent.yml`](../examples/single-repo/.github/workflows/release-agent.yml) to your repo at the same path. For monorepos, use the [`monorepo` example](../examples/monorepo/.github/workflows/release-agent.yml) — the logic is identical; Tagline detects your monorepo flavor automatically.

The workflow has **two triggers**, one per release phase:

- `workflow_dispatch` — fires when you `/approve`. Runs **Phase A (propose)**: bumps versions, writes CHANGELOG, opens the release PR. No tag, no GitHub Release.
- `push` (on `main`/`master`) — fires on every push to the production branch. The action self-filters: it runs the full **Phase B (finalize)** path only when the head commit is the merge of a `release/v*` PR, and no-ops cleanly on every other push. Phase B uses `push` rather than `pull_request: closed` because GitHub's anti-recursion behavior suppresses `pull_request` events on PRs the action itself opened.

Phase A is reversible (close the PR to cancel). Phase B is the publishing step. Nothing ships until you merge.

### Required workflow permissions

The workflow's `permissions:` block must grant exactly three things — these scope the `GITHUB_TOKEN` the action uses inside the run, and are separate from the GitHub App's own permissions:

```yaml
permissions:
    contents: write # commit version bumps, push the release branch (Phase A), create the tag + GitHub release (Phase B)
    pull-requests: write # open the changelog PR back to the production branch (Phase A)
    issues: write # post the acknowledgement comment and close the release-tracking issue (Phase B)
```

The example workflow files already include these. If you build your own workflow and see `Resource not accessible by integration` in the Actions log, you're missing one of the three — most commonly `issues: write`.

## Step 3 — set the AI secret

> [!NOTE]
> Skip this step if you don't want to self-host

Tagline calls an **OpenAI-compatible** endpoint for the report's reasoning. Any provider works — OpenAI, OpenRouter, Anthropic via proxy, Groq, Ollama.

Set the following repo or org secret:

| Secret        | Required? | Default                        |
| ------------- | --------- | ------------------------------ |
| `AI_API_KEY`  | yes       | —                              |
| `AI_BASE_URL` | no        | `https://openrouter.ai/api/v1` |
| `AI_MODEL`    | no        | `google/gemini-3.1-flash-lite` |

If `AI_API_KEY` is unset, Tagline falls back to a deterministic report generated from your commit history with `reasoning: "AI unavailable — manual review required"`.

## Step 4 — optional config

Drop a [`.release-agent.md`](./configuration.md) file in the repo root to customize tracked branches, pre-release suffixes, and release-notes tone. Without one, Tagline defaults to `main` / `staging` / `develop`.

## Step 5 — your first release

Merge a feature PR (`feat:`, `fix:`, or any conventional-commit-typed PR) into your production branch. Tagline opens an issue titled `🚀 Release pending — N change(s) since vX.Y.Z`, labeled `tagline:release-pending`. Every subsequent merge updates the same issue.

That issue is **the** venue for the release. On it, comment:

```
/release-report
```

The bot replies with a formatted report: PRs grouped by type, suggested bump, AI reasoning, and a changelog preview. Review it.

When ready, still on the same issue, comment:

```
/approve            # use the suggested bump
/approve minor      # override the bump
/approve --dry-run  # simulate, no changes
/approve --draft    # create as a draft release
```

Tagline kicks off Phase A. The action opens a release PR (no tag, no GitHub Release yet) and the bot acknowledges with the PR link on the release-tracking issue.

**Review the PR.** When you merge it, Phase B fires automatically: the merge commit is tagged, the GitHub Release is published, the "Ready to share" block is posted back on the release-tracking issue, and the issue is closed. Close the PR without merging to cancel — nothing is tagged or published until merge.

A new release-tracking issue opens automatically the next time a PR merges, and the cycle repeats.

> **Slash commands work only on the bot-managed release-tracking issue.** Comments on any other issue or PR (including the Configure Tagline PR) are silently ignored, so the bot stays quiet on unrelated conversations.

That's it.

## Two changelogs from one approval

Every release produces **two** artifacts, both AI-written in the same call:

1. **A technical `CHANGELOG.md`** — conventional-commits-derived, grouped by `### Added` / `### Fixed` / `### Changed`. For developers and git history.
2. **A plain-language summary** — one headline sentence, a 2–4 sentence body, and 2–5 highlight bullets. No PR numbers, no commit types. For product owners, customers, teammates in non-engineering roles.

The summary appears in three places:

- **The report comment** — collapsible "Plain-language summary" section on the release-tracking issue, so you can review it before approving.
- **The GitHub release body** — pinned above the technical changelog so anyone browsing the Releases page sees the readable version first.
- **The closing comment on the release-tracking issue** — under a "Ready to share" header, posted just before the issue closes. Copy this block into Slack, email, or your product changelog tool with zero editing.

If your AI provider is unavailable, the summary degrades gracefully to a minimal deterministic shape (`{N} updates since {last-tag}` with highlights drawn from PR titles). The section is always there; only the prose quality varies.

## Next steps

- [Slash commands reference](./slash-commands.md)
- [Configuration reference](./configuration.md)
- [Monorepo behavior](./monorepo.md)
- [Self-hosting](./self-hosting.md)
