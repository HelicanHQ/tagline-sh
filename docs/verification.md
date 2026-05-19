# MVP end-to-end verification plan

This document is the playbook for verifying Tagline end-to-end before promoting the MVP to a tagged `v0.1.0` release. It covers everything: the local test pipeline, the in-memory smoke test, single-repo flows on a real GitHub repo, monorepo flows, every versioning scheme, the dual-output release notes, slash-command grammar, error cases, and security-sensitive paths.

The plan is structured so you can:

- Run **Tier 1** (offline) in ~5 minutes to catch most regressions.
- Run **Tier 2** (local bot + smee + test repo) in ~30 minutes to validate the actual webhook → bot → action round-trip.
- Run **Tier 3** (real public repos, monorepo + single, multiple schemes) in ~1–2 hours to catch anything that only surfaces in real GitHub environments.

Skip nothing for the MVP cut. Future regression runs can scope down to Tier 1 + targeted Tier 2/3 cases.

---

## Prerequisites checklist

Before running anything below, verify:

- [ ] Node.js ≥ 24 installed locally (`node --version`).
- [ ] pnpm 10.x installed (`pnpm --version`).
- [ ] You have a working `apps/bot/.env` with: `APP_ID`, `PRIVATE_KEY_PATH`, `WEBHOOK_SECRET`, `WEBHOOK_PROXY_URL` (a smee.io channel), `AI_API_KEY` (OpenRouter or equivalent).
- [ ] You have **two throwaway GitHub repos**:
    - A **single-repo** test repo (any small JS/TS project).
    - A **monorepo** test repo (pnpm workspaces with 2–3 packages, each at a distinct starting version).
- [ ] The forked action repo (`moeen-mahmud/tagline-release-agent-action`) has the latest `dist/index.js` checked in (rebuild via `pnpm --filter @tagline-sh/action build` and copy).
- [ ] The Tagline GitHub App is installed on both test repos.
- [ ] Both test repos have `.github/workflows/release-agent.yml` (copied from `examples/single-repo/` or `examples/monorepo/`).
- [ ] Both test repos have the org/repo "Allow GitHub Actions to create and approve pull requests" toggle enabled.
- [ ] Both test repos have `AI_API_KEY` set as a repo secret (for the action; the bot uses its own env).
- [ ] The bot is running locally via `pnpm --filter @tagline-sh/bot dev` (or smee + a built binary) and you can see webhook events arriving in its log.

---

## Tier 1 — Offline pipeline (≈5 min, runs locally)

Goal: catch every regression that doesn't require GitHub to be in the loop.

### 1.1 Static gates

```bash
pnpm typecheck && pnpm -w run lint && pnpm test && pnpm build
```

**Pass criteria**:

- Typecheck exits 0 in all three packages (shared, bot, action).
- Lint exits 0 with no warnings.
- 192 tests pass (shared 23 + bot 150 + action 19) at MVP-cut baseline. Updates to this baseline should be deliberate — any net decrease without a corresponding test-removal note is a red flag.
- Build emits:
    - `packages/shared/dist/{index.js,index.cjs,index.d.ts,index.d.cts}`
    - `apps/bot/dist/index.js` (~50 KB ESM)
    - `apps/action/dist/index.js` (~1.3 MB CJS)

### 1.2 Dry-run report script

In-memory smoke test that composes every bot service end-to-end against a `FakeGitHubReader` and emits a full `ReleaseReport`. Bypasses Probot entirely.

```bash
pnpm --filter @tagline-sh/bot exec tsx scripts/dry-report.ts
```

**Pass criteria** (inspect the JSON output for these):

- `suggestedBump: "minor"` (the fixture has one `feat` and one `fix`).
- `suggestedVersion: "1.5.0"`.
- `currentVersion: "1.4.2"`.
- `changelogPreview` contains `## [1.5.0]`, `### Added`, `### Fixed`, the feat PR title, the fix PR title.
- `summaryPreview.headline` non-empty.
- `summaryPreview.body` non-empty.
- `summaryPreview.highlights.length` between 1 and 5 inclusive.
- `summaryPreview.rawMarkdown` starts with `## What's new in v1.5.0 · ` followed by today's date in `Month DD, YYYY` UTC.
- `versioningScheme: "semver"`.
- `packages: []` (the dry-report fixture is single-repo).

If any of the above is missing, the report-generator or shared types/utils regressed.

### 1.3 Schema round-trip

The action validates incoming plans against `ReleasePlanSchema`. Round-trip a known-good plan to verify the boundary still catches malformed payloads.

```bash
pnpm --filter @tagline-sh/shared test -- schemas
```

Specifically verify these assertions pass:

- A complete plan accepts (`accepts a known-good plan`).
- Missing `releaseSummary` is rejected.
- `releaseSummary.highlights = []` is rejected (`min(1)`).
- `releaseSummary.highlights` with 6 items is rejected (`max(5)`).
- An unknown `bumpType` value is rejected.
- A non-URL `prs[0].url` is rejected.
- A plan with missing `repoOwner` is rejected.

---

## Tier 2 — Local bot vs. throwaway repo (≈30 min)

Goal: validate the webhook → bot → AI → action → GitHub round-trip on a real (but throwaway) repo, with the bot running locally.

### 2.1 Setup verification

- [ ] Open the smee.io URL in a browser. Trigger any trivial webhook (close and reopen an issue on the test repo). Confirm a payload arrives in smee's UI.
- [ ] In the bot's terminal output, confirm the matching `issue_comment.created` or `pull_request` event was processed (or filtered, if not a slash command).
- [ ] Confirm `process.env.AI_API_KEY` is set in the bot's running process. Without it, the AI path silently falls back to deterministic; the rest of Tier 2 would still pass but you wouldn't be exercising the AI integration.

### 2.2 Single-repo, SemVer (the baseline path)

**Setup**:

- Test repo has at least: one `feat:` PR, one `fix:` PR, one `chore:` PR — all merged into `main` since the last tag.
- No `.release-agent.md` in the repo (use defaults).
- `package.json#version` is a valid semver, e.g. `1.4.2`.

**Steps**:

1. On any issue, comment `/release-report`.
2. Wait ~10 seconds for the bot to edit its acknowledgement into the full report.
3. Verify the report comment contains:
    - Header with last tag + date, branch (`main`), PR/commit/contributor counts.
    - "✨ New features" section listing the `feat` PR.
    - "🐛 Bug fixes" section listing the `fix` PR.
    - "🔧 Chores & maintenance" section listing the `chore` PR.
    - **Recommendation** line: `**Suggested bump:** \`minor\` → \`v1.5.0\``.
    - **AI reasoning** in a blockquote referencing specific PR numbers.
    - **Changelog preview** collapsible section showing the Keep-a-Changelog format.
    - **Plain-language summary** collapsible section showing the AI-generated headline + body + highlights.
    - Slash-command footer: `/approve patch | minor | major | --draft | --dry-run`.
4. Comment `/approve minor --dry-run`.
5. Verify a new acknowledgement comment posts, then the workflow run starts; in the run logs, confirm:
    - Step 1: "Bumping versions to 1.5.0" (one file).
    - Step 2: "Writing CHANGELOG.md" (one file).
    - Step 3+ skipped due to dry-run.
    - Completion comment posted with "dry-run complete".
6. Comment `/approve minor` (no dry-run).
7. Verify in the workflow run:
    - Branch `release/v1.5.0` is created.
    - `package.json` version bumped to `1.5.0`.
    - `CHANGELOG.md` prepended with `## [1.5.0]`.
    - Annotated tag `v1.5.0` is created (single tag).
    - GitHub release `v1.5.0` is published, with the **plain-language summary at the top of the body**, then `---`, then the technical changelog.
    - PR opened from `release/v1.5.0` → `main`.
    - Completion comment posted with the **"Ready to share"** block containing the same summary `rawMarkdown` from the report.
8. Manually merge the release PR.
9. Re-run `/release-report` on a different issue. Verify the report says "No changes detected since `v1.5.0`" (the release PR was filtered by `isReleaseBranch`, not picked up as the next release's PR).

### 2.3 Single-repo, CalVer

**Setup**:

- Add `.release-agent.md` to the test repo root:
    ```markdown
    ## Versioning

    - scheme: calver
    - pattern: YYYY.0M.MICRO
    ```
- Set `package.json#version` to e.g. `2026.04.5` (a previous month) or `2026.05.0` (this month).

**Steps**:

1. Merge any PR (a small `feat` or `fix`).
2. `/release-report`.
3. Verify the report's recommendation line reads `**Next version:** \`v2026.05.1\` _(scheme: calver)_` (or appropriate based on today's date and the previous version).
4. Verify the slash-command footer advertises `/approve as <version>` instead of bump words.
5. Try `/approve minor` — expect a validation error: "Bump words like \`minor\` only apply when \`versioning.scheme\` is \`semver\`."
6. Try `/approve` (no override). The workflow runs, tag `v2026.05.1` is created on the merge commit.

### 2.4 Single-repo, Incremental

**Setup**:

- `.release-agent.md`:
    ```markdown
    ## Versioning

    - scheme: incremental
    ```
- `package.json#version: "41"` or similar trailing integer.

**Steps**:

1. Merge any PR.
2. `/release-report` → "Next version: `v42` (scheme: incremental)".
3. `/approve` → tag `v42`.

### 2.5 Single-repo, AI unavailable (degraded path)

**Setup**:

- Temporarily unset `AI_API_KEY` in the bot's environment, or set it to an invalid value (`sk-invalid`).

**Steps**:

1. Merge a small PR.
2. `/release-report`.
3. Verify the report's "Recommendation" reasoning reads exactly `AI unavailable — manual review required`.
4. Verify the "Plain-language summary" section STILL appears, but with the fallback body (`v{N} includes {N} updates` style) and highlights drawn from PR titles.
5. `/approve patch` should still produce a valid release; verify the GitHub release body uses the fallback summary as its top section.
6. Restore the AI key. Re-test. Confirm rich AI summary returns.

### 2.6 Monorepo, SemVer per-package (the M3 hero case)

**Setup**:

- Test monorepo with three packages:
    - `packages/api` — name `@acme/api`, version `1.0.0`.
    - `packages/ui` — name `@acme/ui`, version `0.5.0`.
    - `packages/db` — name `@acme/db`, version `3.0.0`.
- Merge three PRs:
    - `feat(api): X` touching only `packages/api/`.
    - `fix(ui): Y` touching only `packages/ui/`.
    - (No PRs touching `packages/db/`.)

**Steps**:

1. `/release-report`.
2. Verify the report shows a **per-package table**:
    ```
    | Package    | Current → Next  | Bump  | PRs   |
    | @acme/api  | 1.0.0 → 1.1.0   | minor | #1    |
    | @acme/ui   | 0.5.0 → 0.5.1   | patch | #2    |
    ```
    `@acme/db` is **absent** from the table.
3. The "Suggested bump" single-line is **absent** — replaced by the table.
4. The plain-language summary appears as usual (repo-level, not per-package — addendum §9).
5. The slash-command footer advertises `/approve <name>:<bump>` instead of `/approve patch | minor | major`.
6. Try `/approve minor` — expect a validation error pointing to the per-package grammar.
7. Try `/approve api:major ui:patch`:
    - The action runs.
    - `packages/api/package.json` is bumped to `2.0.0` (NOT `1.1.0` — the override applied).
    - `packages/ui/package.json` is bumped to `0.5.1` (patch).
    - `packages/db/package.json` is **untouched** (still `3.0.0`).
    - Two annotated tags pushed: `@acme/api@2.0.0`, `@acme/ui@0.5.1`. No `v…` event tag.
    - Branch `release/vevent-YYYY-MM-DD` created and PR opened.
    - Per-package CHANGELOGs:
        - `packages/api/CHANGELOG.md` has `## [2.0.0]` and references PR #1 only.
        - `packages/ui/CHANGELOG.md` has `## [0.5.1]` and references PR #2 only.
        - `packages/db/CHANGELOG.md` is **unchanged** (no entry added).
    - Root `CHANGELOG.md` has `## [event-YYYY-MM-DD]` listing both packages with deep-links to per-package CHANGELOGs.
8. Verify completion comment includes both tags in its body and the "Ready to share" plain-language summary.

### 2.7 Monorepo, CalVer (independent per-package MICRO counters)

**Setup**:

- Same monorepo as above, but `.release-agent.md` declares `scheme: calver` with pattern `YYYY.MM.MICRO`.
- Set initial versions: `@acme/api@2026.4.0`, `@acme/ui@2026.4.0`, `@acme/db@2026.4.0`.
- Merge a feature PR touching only `packages/api/`.

**Steps**:

1. `/release-report` today (May 19, say).
2. The per-package table shows ONLY `@acme/api`, computed as `2026.4.0 → 2026.5.0` (month rollover → MICRO resets).
3. `@acme/ui` and `@acme/db` are absent (no PRs touched them).
4. `/approve` — action runs, `@acme/api@2026.5.0` tag pushed.
5. Merge another PR touching only `packages/api/` on the same day. `/release-report` again. New table: `@acme/api: 2026.5.0 → 2026.5.1` (same month, MICRO increments).
6. Merge a PR touching only `packages/ui/`. `/release-report`. Table: `@acme/ui: 2026.4.0 → 2026.5.0` (its own MICRO reset, INDEPENDENTLY of api's `2026.5.1`). `@acme/api` should be **absent** from this table (no new PRs touched it).
7. `/approve`. Verify `@acme/ui@2026.5.0` is pushed; `@acme/api` is untouched at `2026.5.1`.

This step validates the user's killer scenario: "release webapp + api on the same day, but not the database; per-package MICRO independence."

### 2.8 Monorepo override-grammar edge cases

For each of these, comment the indicated `/approve …` and confirm the bot's reply matches the expected validation message:

| Input                                                            | Expected outcome                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `/approve api:typo`                                              | Rejected — "I didn't understand that `/approve` command" (unknown token)              |
| `/approve fake-pkg:minor` (where `fake-pkg` isn't in the report) | Validation error: "Unknown package in override: `fake-pkg`. This release includes: …" |
| `/approve api:minor api:patch` (duplicate package)               | Rejected at parse — "I didn't understand that `/approve` command"                     |
| `/approve minor api:patch` (mixed global + per-package)          | Rejected at parse                                                                     |
| `/approve as 2026.6.0` (on a monorepo)                           | Validation error pointing to per-package grammar                                      |
| `/approve api:minor --dry-run`                                   | Accepted; dry-run runs successfully                                                   |

### 2.9 Permission gating

- Try `/release-report` from a GitHub account that has **read-only** access to the test repo.
- Expect the bot to reply asking the actor to request write access; no AI call, no workflow dispatch.

### 2.10 Idempotency safeguard (Phase B)

- After a successful release on `v1.5.0`, manually re-dispatch the Phase B workflow run from the GitHub Actions UI for the same merged PR (Re-run jobs).
- Expect Phase B to log `Reference already exists` for the tag and `release already exists` for the GitHub Release, and skip both. The finalize result is still `success` — re-runs are idempotent, not destructive.
- For a monorepo with partial state (e.g. someone manually created `@acme/api@1.1.0` before merge but not `@acme/ui@0.5.1`): Phase B creates the missing tag(s) and skips the existing one(s) without aborting the rest.

### 2.11 Two-phase contract: cancel by closing

- Run `/approve` on the test repo to open a release PR.
- Verify: NO tag exists yet (`gh api repos/<owner>/<repo>/tags`), NO GitHub Release exists yet (`gh release list`).
- **Close** the release PR (don't merge).
- Verify: still no tag, no release. The workflow either doesn't trigger (closed-without-merge filter) or triggers and logs "PR was closed without merging — skipping finalize."
- Run `/approve` again — should be able to start a fresh release proposal without conflict.

### 2.12 Two-phase contract: tag lands on merge commit

- Run `/approve`, then merge the release PR (squash or merge commit).
- After Phase B completes, confirm the tag is on the **merge commit on `main`**, not on the orphan release branch:
  ```bash
  git fetch --tags
  git branch -a --contains $(git rev-list -n 1 v1.5.0)
  # Should include main/origin/main — proves the tag lives on the production branch.
  ```
- This is the key behavioral difference vs. the old single-phase architecture, where the tag was on the release branch's commit and would orphan if the PR were ever closed without merging.

---

## Tier 3 — Real public repos (≈1–2 hours, optional but recommended)

Goal: catch anything that only surfaces in real GitHub environments — rate limits, large PR sets, GitHub Search API quirks, real-world conventional commit messiness.

### 3.1 The velaops case (CalVer monorepo regression check)

- Install Tagline on `moeen-mahmud/velaops` (assuming the previous M1 setup is still in place).
- Run `/release-report` once to confirm the previous-release-PR filter still works (M1 fix).
- Confirm no leak of prior release PRs into the "since last tag" set.

### 3.2 Active OSS project (representative SemVer monorepo)

- Fork a real pnpm-workspaces monorepo (e.g. one of your own projects with 3+ active packages).
- Install Tagline, generate a release report against a development branch with 10+ merged PRs.
- Verify:
    - The per-package table renders correctly even with many packages.
    - The AI reasoning is coherent and references specific PRs.
    - The plain-language summary is genuinely readable (not jargon-y).
- Approve a dry-run, then approve a real release.

### 3.3 Long PR history (rate limit exercise)

- Pick a repo with 50+ merged PRs since its last tag.
- Run `/release-report` and time it; verify it completes within ~30 seconds.
- Watch the bot logs for any 403/429 errors (rate limiting) or retry behavior.

### 3.4 AI provider failover

- Switch the bot's `AI_BASE_URL` to a deliberately-broken endpoint mid-session.
- Run `/release-report` — verify it falls back to deterministic cleanly without throwing.
- Restore the endpoint.

### 3.5 Self-hosted Docker

- Build the bot Docker image: `docker build -t tagline-bot .`
- Bring up the stack: `docker compose up -d` with the production env vars.
- Repeat 2.2 (single-repo SemVer) against the dockerized bot. Verify everything still works.

---

## Verification matrix summary

For the MVP cut, every cell below should be checked off:

| Scenario                                     | Tier 1  | Tier 2           | Tier 3  |
| -------------------------------------------- | ------- | ---------------- | ------- |
| Static gates (typecheck/lint/test/build)     | ✅ §1.1 | —                | —       |
| Schema round-trip                            | ✅ §1.3 | —                | —       |
| dry-report.ts smoke                          | ✅ §1.2 | —                | —       |
| Single-repo SemVer happy path                | —       | ✅ §2.2          | (3.2)   |
| Single-repo SemVer dry-run                   | —       | ✅ §2.2 step 4–5 | —       |
| Single-repo CalVer                           | —       | ✅ §2.3          | —       |
| Single-repo Incremental                      | —       | ✅ §2.4          | —       |
| AI-unavailable degradation                   | —       | ✅ §2.5          | ✅ §3.4 |
| Monorepo SemVer (per-package + table + tags) | —       | ✅ §2.6          | ✅ §3.2 |
| Monorepo CalVer (independent MICRO)          | —       | ✅ §2.7          | —       |
| Override grammar edge cases                  | —       | ✅ §2.8          | —       |
| Permission gating                            | —       | ✅ §2.9          | —       |
| Idempotency safeguards                       | —       | ✅ §2.10         | —       |
| Previous-release-PR leak filter (M1)         | —       | ✅ §2.2 step 9   | ✅ §3.1 |
| Plain-language summary appears in 3 places   | —       | ✅ §2.2, §2.6    | —       |
| Rate limit / large-history endurance         | —       | —                | ✅ §3.3 |
| Self-hosted Docker                           | —       | —                | ✅ §3.5 |

---

## Known limitations (document, don't fix)

These are explicit MVP non-goals — surfacing them in verification so you don't waste time chasing them:

- **No release-event-level GitHub Release for monorepos.** Each per-package tag does NOT get its own GitHub Release page in the MVP. The release event produces tags + a PR + a completion comment, but the GitHub UI's Releases tab is single-tag-centric and we don't (yet) create one per package.
- **No exclude flag for packages.** A monorepo package can only be skipped by NOT having any PRs touch it. If a package has PRs but you want to skip it, you can't — yet.
- **No cross-package version coupling.** Lockstep releases of multiple packages (e.g. "always release `@acme/api` and `@acme/types` together") aren't enforced.
- **No release-please-style commit-body `Release-As: X` override.** Use slash commands instead.
- **No GitLab / Bitbucket support.** GitHub only.
- **No JIRA/Linear API integration.** Ticket numbers extracted by regex only.

If any of these surface during verification as a blocker, that's a scope-creep signal worth pausing on before merging the MVP cut.

---

## Sign-off

When all checkboxes in the matrix are green:

- [ ] Tag the repo `v0.1.0`.
- [ ] Update the GitHub App description to reference the dual-output marketing hook ("the changelog that's actually readable").
- [ ] Cross-post the MVP announcement to the Reddit thread that started this whole arc.
- [ ] Start scoping v0.2 (Release-PR pattern from the deferred post-MVP roadmap).

Failures or surprises that surface during verification should land as follow-up tasks in `tasks` (or as new milestones in `plans/`) rather than blocking the MVP cut.
