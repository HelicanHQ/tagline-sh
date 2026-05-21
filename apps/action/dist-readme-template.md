# tagline-release-agent-action

> **This is a build-artifact repository.** The bundled action code lives here so consumers can pin it from their workflows. The source, documentation, issue tracker, and release notes live upstream in **[{{SOURCE_REPO}}]({{SOURCE_REPO_URL}})**.

Released as **{{TAG}}** — see the [matching upstream release]({{SOURCE_RELEASE_URL}}) for changelog and full notes.

---

## What this action does

Tagline is a GitHub-native release-management agent. The bot (hosted separately) reads merged PRs, opens a release-tracking issue per release cycle, and waits for a maintainer to `/approve`. **This action is the write half** — it bumps versions, writes `CHANGELOG.md`, opens the release PR, and on merge, creates the tag and GitHub Release.

The bot never writes to your repo. Only this action does, and only inside your own CI with your own `GITHUB_TOKEN`. Your branch protections and audit log stay intact.

For the full architectural overview, see the [upstream README]({{SOURCE_README_URL}}).

## Quick start

Drop this into `.github/workflows/release-agent.yml` in your repo:

```yaml
name: Tagline Release Agent
on:
    workflow_dispatch:
        inputs:
            release_plan:
                description: 'Release plan (JSON, set by the Tagline bot)'
                required: true
    push:
        branches: [main, master]

permissions:
    contents: write
    pull-requests: write
    issues: write

jobs:
    release:
        runs-on: ubuntu-latest
        steps:
            - uses: actions/checkout@v4
              with:
                  fetch-depth: 0
            - uses: {{ACTION_REF}}@v1
              with:
                  github-token: ${{ secrets.GITHUB_TOKEN }}
```

Then install the [Tagline GitHub App]({{APP_INSTALL_URL}}) on your repository. The bot will open a release-tracking issue when PRs start landing.

## Pinning

| Pin | When to use |
|-----|-------------|
| `{{ACTION_REF}}@v1` | **Recommended.** Rolling major tag — you automatically get patch and minor releases inside v1. Breaking changes will land under v2 and won't move this pin. |
| `{{ACTION_REF}}@{{TAG}}` | Pin to an exact release. Predictable; you decide when to upgrade. Requires you to bump manually. |
| `{{ACTION_REF}}@<commit-sha>` | Pin to a specific bundled commit. Most paranoid option — protects against tag-tampering attacks. See [upstream security policy]({{SOURCE_SECURITY_URL}}) for the discussion. |

The rolling `v1` tag is force-moved with each minor/patch release. Pre-release tags (`-rc`, `-alpha`, `-beta`) are deliberately **not** mirrored here — only stable releases reach this repo.

## Where things live

- **Source code and architecture:** [{{SOURCE_REPO}}]({{SOURCE_REPO_URL}})
- **Documentation and getting-started guide:** [{{SOURCE_REPO}}#readme]({{SOURCE_README_URL}})
- **Issue tracker:** [{{SOURCE_REPO}}/issues]({{SOURCE_ISSUES_URL}}) — please file bugs and feature requests upstream, not on this repo
- **Security policy and SHA-pinning guide:** [docs/security.md]({{SOURCE_SECURITY_URL}})
- **Self-hosting the bot:** [docs/self-hosting.md]({{SOURCE_SELF_HOSTING_URL}})
- **Release notes and changelogs:** [{{SOURCE_REPO}}/releases]({{SOURCE_RELEASES_URL}})

## What lives in this repo

This repository is intentionally minimal — it carries only the artifacts needed to reference the action from your workflow:

- **`action.yml`** — the GitHub Action manifest (`runs.using: node20`).
- **`dist/index.js`** — the bundled action code (tsup CJS bundle of `apps/action/` from upstream). Roughly 1.3 MB; every runtime dependency is inlined because `node_modules/` is not available at action-runtime.
- **`README.md`** — this file.
- **`LICENSE`** — MIT, identical to the upstream license.

Both `action.yml` and `dist/index.js` are rebuilt and pushed by an upstream workflow ([`.github/workflows/release.yml`]({{SOURCE_RELEASE_WORKFLOW_URL}})) on every stable tag. They are **never edited by hand** — any PR opened directly against this repo will be closed; please contribute upstream.

## License

MIT — see [`LICENSE`](./LICENSE). Identical to the [upstream license]({{SOURCE_LICENSE_URL}}).
