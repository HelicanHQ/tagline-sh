# Security & supply-chain guidance

Tagline ships in two halves: the **bot** (a GitHub App you install or self-host) and the **action** (`tagline-sh/release-agent-action`, referenced from your workflow YAML). Each half has a different trust model — this doc spells them out.

## The action is what runs in your CI

Everything that writes to your repository runs inside the GitHub Action, in your own runner, with your own `GITHUB_TOKEN`. The bot is a stateless intelligence layer that posts comments; it has no commit, tag, or release capability against your code.

This means the only piece of Tagline you need to harden against supply-chain risk is the action reference in your workflow YAML.

## Recommended pinning strategy (default)

```yaml
- uses: tagline-sh/release-agent-action@v1
```

The rolling `v1` major tag is force-moved by [`release.yml`](../.github/workflows/release.yml) every time a new `v1.x.y` ships. You get patch + minor releases automatically; you don't pick up `v2` (which would be allowed to introduce breaking changes) without changing the YAML.

This is the same pattern used by `actions/checkout@v4`, `actions/setup-node@v4`, and basically every well-maintained action in the GitHub ecosystem. It's the right default for most teams.

## SHA pinning (for paranoid environments)

If your organization requires every action reference to be pinned to a specific commit SHA — common in regulated environments, supply-chain-attack-conscious orgs, or anyone running [Dependabot's `version-updates` for `github-actions`](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/keeping-your-actions-up-to-date-with-dependabot) — pin the SHA instead:

```yaml
- uses: tagline-sh/release-agent-action@<full-40-char-sha>  # v1.2.3
```

The trailing comment is the convention Dependabot reads; it auto-bumps the SHA when a new release tag lands and includes the human-readable version in the PR.

### Trade-off

- **Rolling tag (`@v1`)** — convenient. You trust that the maintainer (or their CI) will only force-move `v1` to commits inside the v1.x.y semver range. The risk: if the maintainer's tag-push credentials are compromised, an attacker could force-move `v1` to a malicious commit.
- **SHA pinning (`@<sha>`)** — paranoid. Even a compromised tag-push credential can't substitute the SHA you've pinned. The cost: someone (you, or Dependabot) has to actively bump the SHA to get bug fixes.

There's no wrong answer. Most users should stick with `@v1`; teams whose threat model explicitly includes supply-chain attacks on action authors should pin SHAs.

## What the action's `GITHUB_TOKEN` can do

The example workflow grants:

```yaml
permissions:
    contents: write       # commit version bumps; push the release branch; create tags + releases
    pull-requests: write  # open the release PR
    issues: write         # post acknowledgement + close the release-tracking issue
```

These are the minimum required. Tagline does NOT need (and should not be granted):

- `actions: write` — Tagline does not trigger or modify workflows.
- `deployments: write` — Tagline does not create deployments.
- `packages: write` — Tagline does not publish packages to GitHub Packages.
- `id-token: write` — Tagline does not use OIDC.

If your org enforces "least-privilege workflow permissions" via repo or org settings, the three above are the entire list — block everything else.

## What the bot's GitHub App can do

If you install the hosted bot (`github.com/apps/tagline-sh`), it requests:

| Permission | Why |
|---|---|
| `Contents: Read` | Read PR diffs, conventional commits, `.release-agent.md`, `package.json`. |
| `Contents: Write` | Open the Configure Tagline PR on install (adds `.release-agent.md`). |
| `Issues: Read & Write` | Manage the release-tracking issue (open, update body, close, label). |
| `Pull Requests: Read & Write` | Open the Configure PR; read PR metadata for reports. |
| `Actions: Read & Write` | Dispatch the `release-agent.yml` workflow on `/approve`. |
| `Metadata: Read` | Required for any App; lists installed repos. |

The bot does NOT request `workflows: write` — meaning it cannot create or modify files under `.github/workflows/`. The Configure PR ships only `.release-agent.md`; the workflow YAML is for the user to copy in (it's embedded in the PR body for that purpose).

If you self-host the bot, you control the App registration and can omit any permission you don't need at the cost of disabling the corresponding feature.

## Reporting a vulnerability

If you find a security issue in Tagline that should not be disclosed publicly, please email the maintainer (see `package.json` author field) rather than opening a public issue. Coordinated disclosure preferred.
