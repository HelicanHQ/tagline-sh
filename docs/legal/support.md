# Support

> **DRAFT — refine before publishing as `tagline.sh/support`.** Placeholders are marked `{{LIKE_THIS}}`.

Tagline is open source and maintained on a best-effort basis. This page explains where to get help, what we commit to, and what falls outside that scope.

## Where to file what

| What you want to do | Where to go |
|---|---|
| **Report a bug** in the bot, the action, or the docs | <https://github.com/HelicanHQ/tagline-sh/issues/new?template=bug.yml> |
| **Request a feature** or share a use case we don't cover | <https://github.com/HelicanHQ/tagline-sh/issues/new?template=feature.yml> |
| **Ask a how-do-I question** | [GitHub Discussions](https://github.com/HelicanHQ/tagline-sh/discussions) — please search first |
| **Report a security issue** | {{SECURITY_CONTACT_EMAIL}} — see [`docs/security.md`](../security.md) for the responsible-disclosure guidance |
| **General contact** | {{SUPPORT_CONTACT_EMAIL}} |
| **Privacy or legal enquiries** | {{PRIVACY_CONTACT_EMAIL}} |

Please **do not** open issues on the distribution repository ([`HelicanHQ/tagline-release-agent-action`](https://github.com/HelicanHQ/tagline-release-agent-action)) — issues there are disabled because that repo only mirrors the action bundle. All bug reports, feature requests, and discussions belong on the source repository.

## What we commit to

- **Bug reports** are acknowledged within {{BUG_ACK_DAYS}} business days. Acknowledgement is not a promise of a fix on any particular timeline.
- **Security reports** receive a same-day acknowledgement (within {{SECURITY_ACK_HOURS}} hours during business days) and a coordinated disclosure window.
- **Critical bugs** affecting the hosted instance's ability to receive webhooks or process releases are prioritised over feature requests and non-critical bugs.
- **Documentation gaps** flagged in issues are treated as bugs.

## What falls outside the scope of support

The following are **out of scope** for the hosted instance and the open-source project:

- **Custom deployment configurations** for self-hosters. The [self-hosting guide](../self-hosting.md) covers Docker Compose, Railway, and bare-metal patterns; other patterns are unsupported.
- **Repository-specific debugging** that requires us to inspect private code. We can debug from logs and reproducible public test cases; we will not request, and cannot read, the contents of private repositories.
- **AI provider behaviour or quality.** If the AI narrative is poor, that is a function of the model you (or the hosted instance) selected. The deterministic fallback always works.
- **Custom version-bump policies** outside the conventional-commits-based bump map documented in [`PLAN.md §11`](../../PLAN.md).
- **Slack/Teams/Discord integrations**, **GitLab/Bitbucket support**, **JIRA/Linear API enrichment**, **rollback monitoring** — these are deliberately out of scope per the published roadmap.
- **Migration help from other release tools** — we'll happily review a clear bug report, but we cannot provide bespoke migration consulting through community support.

## Self-hosters

If you self-host the bot, our support is limited to:

1. The published documentation and code being correct against the stated dependencies.
2. Best-effort responses to reproducible bug reports filed against the public source repository.

We cannot provide direct support for self-hosted instances (we have no visibility into them), but every fix that lands in the source repository becomes available to self-hosters via the standard upgrade path documented in [`self-hosting.md`](../self-hosting.md).

## Response expectations

Tagline is maintained by {{MAINTAINER_HEADCOUNT}} maintainer(s). Response time scales with maintainer availability and backlog. We will not commit to specific resolution SLAs for individual issues; the acknowledgement SLAs above are the only formal commitment.

If you need a higher level of support — guaranteed response times, custom feature work, or dedicated office hours — please reach out to {{SUPPORT_CONTACT_EMAIL}} to discuss whether a sponsored arrangement is possible.
