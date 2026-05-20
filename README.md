# Tagline

> GitHub-native release-management agent. Automates the **thinking step** of releasing, not just the mechanics.

Most release tools (semantic-release, changesets) automate what happens *after* you decide to release. Tagline closes the gap before that decision: it reads merged PRs since your last tag, understands conventional commits, generates a human-readable report with an AI-reasoned version bump suggestion, and — once you `/approve` — runs the release end-to-end.

You stay in control. The bot only suggests; the action only runs on your explicit approval.

## How it works

```
A PR merges into your production branch
              ↓
       Bot opens (or updates) a release-tracking issue
       labeled `tagline:release-pending`
              ↓
Lead comments /release-report ON THAT ISSUE
              ↓
       Bot reads PRs since last tag, parses commits, calls AI
              ↓
       Bot edits the report into the issue thread with the
       suggested bump + reasoning
              ↓
Lead comments /approve minor (still on the release issue)
              ↓
       Bot triggers workflow_dispatch with the release plan
              ↓
   ┌──── Phase A — propose ────────────────────────────────────┐
   │  Action bumps version, writes CHANGELOG.md, pushes the     │
   │  release/vX.Y.Z branch, opens a release PR.                │
   │  NO tag, NO GitHub Release yet. Acknowledgement comment    │
   │  goes back to the release-tracking issue.                  │
   └────────────────────────────────────────────────────────────┘
              ↓
Lead reviews the PR, merges it (or closes it to cancel)
              ↓
   ┌──── Phase B — finalize (on push to production) ───────────┐
   │  Action tags the merge commit, publishes the GitHub        │
   │  Release with the plain-language summary above the         │
   │  technical changelog, posts the "Ready to share" block     │
   │  on the release-tracking issue, and closes it.             │
   └────────────────────────────────────────────────────────────┘
```

Nothing is tagged or published until the release PR is merged. The bot **never writes** to your repo. Only the action does, and only inside your own CI with your own `GITHUB_TOKEN`. Your branch protections and audit log stay intact.

Slash commands work **only** on the bot-managed release-tracking issue (identified by the `tagline:release-pending` label plus a hidden marker in the issue body). Comments anywhere else are ignored silently — no notification spam.

## Five-minute install

1. Install the [Tagline GitHub App](https://github.com/apps/tagline-sh) on a repo. (Or [self-host](./docs/self-hosting.md).)
2. Copy [`examples/single-repo/.github/workflows/release-agent.yml`](./examples/single-repo/.github/workflows/release-agent.yml) into your repo. (Monorepo? Use [`examples/monorepo/...`](./examples/monorepo/.github/workflows/release-agent.yml) — same file.)
3. Add an `AI_API_KEY` repo secret. Any OpenAI-compatible provider: OpenAI, OpenRouter, Groq, Ollama, Anthropic via proxy.
4. Merge a PR. Tagline opens a `🚀 Release pending` issue.
5. Comment `/release-report` on that issue, then `/approve` to ship.

Full walkthrough: [Getting started](./docs/getting-started.md).

## Slash commands

```
/release-report
/release-report --branch staging

/approve
/approve patch | minor | major
/approve --draft
/approve --dry-run
/approve minor --draft
```

See [slash-commands.md](./docs/slash-commands.md) for behavior, error cases, and the comment lifecycle.

## Highlights

- **GitHub-native UX.** One canonical release-tracking issue per release cycle, opened automatically when PRs land. No dashboard, no separate login, no comments-on-random-issues confusion.
- **AI is an enhancement, never a dependency.** Calls fail open: reports still generate deterministically from commits, with the reasoning replaced by `"AI unavailable — manual review required"`.
- **Stateless by design.** GitHub is the state store. Git tags = last release. `.release-agent.md` = config. No database to operate.
- **Monorepo-aware.** Auto-detects pnpm-workspaces, Turborepo, Nx, Lerna, npm/yarn workspaces. Each affected package versioned independently.
- **BYOK.** OpenAI-compatible API. Override `AI_BASE_URL` and `AI_MODEL` for any provider; default is OpenRouter + `gpt-4o-mini` for cost.
- **MIT licensed.** CLI and Action are free forever. Hosted GitHub App is free for OSS; paid for private repos (post-MVP).

## Architecture

Two-component split — the bot thinks, the action writes.

| Package | What it is |
|---------|------------|
| `apps/bot` | Probot GitHub App. Stateless. Reads from GitHub on demand. Posts comments. Never writes to user repos. |
| `apps/action` | Node 20 GitHub Action. Runs in two phases: `workflow_dispatch` (propose — bump + CHANGELOG + branch + PR, no tag) and `push` to the production branch (finalize — tag the merge commit + publish GitHub Release + close the release-tracking issue when the release PR lands). |
| `packages/shared` | TypeScript types + zod schemas. The `ReleasePlan` contract between bot and action. |

The action runs **in the user's CI**, with the user's secrets and audit log. The bot only proposes; the action only acts on explicit `/approve`.

Full architectural detail: [`PLAN.md`](./PLAN.md).

## Local development

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Bot dev requires a personal GitHub App + smee.io webhook proxy — see [`apps/bot/README.md`](./apps/bot/README.md).

## Documentation

- [Getting started](./docs/getting-started.md)
- [Slash commands](./docs/slash-commands.md)
- [Configuration (`.release-agent.md`)](./docs/configuration.md)
- [Monorepo behavior](./docs/monorepo.md)
- [Self-hosting](./docs/self-hosting.md)

## Roadmap

This repo ships the MVP. Post-validation roadmap (from `PLAN.md §24`):

- JIRA / Linear API enrichment of ticket refs
- Slack / Teams / Discord release notifications
- Web dashboard for release history + per-repo settings
- GitLab / Bitbucket support
- Independent versioning per monorepo package
- Rollback monitoring + post-release health checks

## License

MIT — see [LICENSE](./LICENSE). Self-hosting is a feature, not a threat.
