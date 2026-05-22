# GitHub Marketplace transparency disclosure

## Security

- **Webhook authentication.** Probot v13 verifies HMAC signatures on every webhook against a per-install `WEBHOOK_SECRET`; invalid payloads are rejected.
- **TLS** on every external hop (GitHub ↔ bot, bot → OpenRouter, action → GitHub).
- **Secrets** (GitHub App private key, webhook secret, AI API key) live in environment variables on the host — never in source.
- **Permission gates.** Every slash command requires `write`, `maintain`, or `admin` access. Re-checked per command, never cached.
- **Bot is read-only against user repos.** All release writes (commits, tags, GitHub Releases) happen via a separate GitHub Action in the user's own CI with their `GITHUB_TOKEN` — under their audit log, with their branch protections intact.
- **Human-in-the-loop.** No release happens without an explicit `/approve` from a permitted user.

## Data handling

- **Stateless, no database.** Webhook payloads are processed in-memory and discarded. Installation tokens are short-lived and never stored.
- **Sent to OpenRouter (AI):** conventional-commit-prefix-stripped PR titles, affected package names, last release version. PR bodies, source code, secrets, and user identifiers beyond what's public on merged PRs are NOT sent.
- **Logs** (pino structured JSON) retained at Railway's standard retention; may contain transient repo names, PR numbers, GitHub handles. No aggregation, profiling, or sale.
- **Data subject rights.** Uninstalling stops processing immediately. The stateless design means no profile to access, export, or delete. Confidential GDPR/CCPA requests via GitHub private vulnerability reporting.
- **Cross-border.** Hosted instance: Railway (US); OpenRouter (US). Self-hosters pick their own jurisdiction and AI provider.

Privacy / Terms / Support: https://github.com/HelicanHQ/tagline-sh/tree/main/docs/legal

## Compliance

No third-party security certifications (SOC 2, ISO 27001, HIPAA, FedRAMP) — small, pre-incorporation project.

**GDPR / CCPA:** best-effort posture grounded in the stateless architecture. No persisted user profile means the right-to-access/delete surface is minimal by design. MIT licensed; self-hosting fully supported.

## EU AI Act classification

**Not high-risk** under Article 6 + Annex III. AI output is a suggested release-note narrative — informational only — gated by explicit human `/approve`.

- **Human oversight (Art. 14):** every AI output requires explicit approval from a repo administrator. Users review, edit, or override at any time.
- **Accuracy & limitations (Art. 15 principles):** narrative quality depends on the configured model. Tagline ships a deterministic-from-commits fallback that always works without AI, with reasoning replaced by "AI unavailable — manual review required."
- **No automated decisions affecting natural persons.** Tagline operates on git artifacts (commits, PRs, tags); no decisions about individuals are made.

<!--
## Maintenance triggers (re-publish this disclosure when any of these happen)

- A new third-party service is added (auth provider, observability, error reporting, email, etc.).
- The AI provider or data sent to it changes.
- A database or persistent store is introduced (the stateless-design claim above would no longer be true).
- The human-in-the-loop `/approve` gate is removed or weakened.
- Compliance posture changes — e.g. SOC 2 audit completed, dedicated DPO appointed.
- The EU AI Act classification shifts (new Annex III addition affecting developer tools, or a feature is added that automates decisions about people).
- The hosted infrastructure jurisdiction changes (currently US via Railway).
-->
