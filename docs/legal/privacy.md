# Privacy Policy

> **DRAFT — review with counsel before publishing.** This file is the starting point for the policy that will be served at `tagline.sh/privacy`. Placeholders are marked `{{LIKE_THIS}}`.

**Effective date:** {{EFFECTIVE_DATE}}
**Operator:** {{OPERATOR_LEGAL_NAME}} ("we", "us", "Tagline")
**Contact:** {{PRIVACY_CONTACT_EMAIL}}

This policy describes what data Tagline processes when you install the Tagline GitHub App on a repository, and what we do — and do not — do with it.

## What Tagline is

Tagline is a GitHub-native release-management agent. It reads merged pull requests on the repositories where you install it, generates a release report, and runs a GitHub Action under your own CI to cut releases. The Tagline GitHub App ("the bot") only **proposes** releases; it never writes to your repositories. The release action runs inside your own GitHub Actions environment, with your own `GITHUB_TOKEN`, and produces all writes (tags, commits, GitHub Releases) under your account's audit log.

## What we process

When you install the Tagline GitHub App, the bot receives webhook payloads from GitHub for the events it subscribes to (currently: `pull_request`, `issue_comment`, `installation`). Each payload may include:

- The repository name and identifier
- Pull request titles, descriptions, commit messages, and author handles
- Comment text (used to detect slash commands like `/release-report` and `/approve`)
- The GitHub login of the user who triggered the event
- A short-lived GitHub App installation token, used to read further data from your repository on demand (e.g. PR lists, tags, the `.release-agent.md` config file)

The bot reads additional repository data **on demand** through the GitHub API to assemble release reports — for example, the list of PRs merged since your last release tag, and the contents of your `.release-agent.md` configuration file.

## What we do not store

Tagline is stateless by design. We do not operate a database. We do not persist:

- Webhook payloads beyond the seconds needed to process them
- The contents of pull requests, commits, or comments
- Any user identifier, beyond what appears in transient request logs
- GitHub App installation tokens (these are short-lived and discarded after each request)

Operational logs (structured JSON via [pino](https://getpino.io)) may contain transient references to repository names, PR numbers, and GitHub handles for the duration of standard log retention on our hosting provider. We do not aggregate, profile, or sell this data.

## Third-party processors

Tagline forwards the **summary of merged PRs** to an AI provider (OpenAI-compatible API) in order to generate the human-readable narrative portion of each release report. On the hosted instance, this provider is currently {{HOSTED_AI_PROVIDER}}. The data sent to the AI provider is limited to:

- The commit-type-prefix-stripped titles of merged PRs since the last release tag
- The names of touched packages (for monorepo detection)
- The last release version string

We do not send the body of pull requests, source code, secret values, or any user identifier beyond what is publicly visible on the merged PRs themselves.

If you **self-host** the bot (a fully supported configuration — see [self-hosting](../self-hosting.md)), the choice of AI provider is yours, and the data sent to your provider passes through your own infrastructure. We have no visibility into it.

## Subprocessors used by the hosted instance

The hosted instance currently relies on the following infrastructure providers:

- {{HOSTING_PROVIDER}} — application hosting and TLS termination
- {{AI_PROVIDER}} — AI-powered release narrative generation
- GitHub, Inc. — webhook delivery and API access (governed by [GitHub's privacy practices](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement))

We will update this list if subprocessors change. If you need a formal subprocessor notification mechanism, please contact us at {{PRIVACY_CONTACT_EMAIL}}.

## Your rights

Because Tagline does not persist personal data, there is no profile or account to access, export, or delete. The right to control your data over Tagline is effectively exercised by:

- **Uninstalling** the GitHub App from your repository — the bot will stop receiving webhooks immediately
- **Revoking** the GitHub App's installation token from your organisation's GitHub settings
- **Self-hosting** — for the strongest possible data sovereignty, run your own instance on your own infrastructure with your own AI provider

If you have specific GDPR, CCPA, or other jurisdictional requests, please contact us at {{PRIVACY_CONTACT_EMAIL}}. We will respond within {{RESPONSE_SLA_DAYS}} days.

## Security

- All traffic between GitHub and the bot is over TLS, with GitHub's signed webhook payloads verified against the App's webhook secret.
- The bot's GitHub App private key is stored as a secret at the hosting provider and is not committed to source control.
- The release action runs entirely inside your GitHub Actions environment; we have no access to your repository's secrets.

We do not currently maintain a formal bug-bounty programme, but security reports are welcomed at {{SECURITY_CONTACT_EMAIL}}. Please give us a reasonable disclosure window before public posting.

## Changes to this policy

Material changes will be announced via {{ANNOUNCEMENT_CHANNEL}} and reflected in the `Effective date` above. If a change materially expands what data we process or transmit, we will notify active installations directly through the GitHub App.

## Contact

Privacy enquiries: {{PRIVACY_CONTACT_EMAIL}}
Security: {{SECURITY_CONTACT_EMAIL}}
General: {{SUPPORT_CONTACT_EMAIL}}
