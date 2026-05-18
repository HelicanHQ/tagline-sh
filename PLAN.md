# PLAN.md — Release Agent

> This document is the single source of truth for building the Release Agent MVP.
> It is written for Claude Opus to read and implement end-to-end without additional context.
> Every decision, trade-off, and constraint is documented here.

---

## 1. Product Overview

### What Is This?

Release Agent is an open-source GitHub-native AI agent that automates the thinking step
of the software release process — not just the mechanics.

Most release tools (semantic-release, changesets) automate _what happens_ after you decide
to release. They do not help you decide _what_ changed, _why_ it matters, or _what kind_ of
release it should be. That decision still falls on the engineering lead, who ends up reading
through every merged PR manually before every release. Also, configuring and setup the release process is hectical. Whether you want a minor or a patch, or a major, it’s all done by the engineering lead. However, configuring a release process is a complex task that requires a lot. For example, whether the package should follow Cal-Ver, Sem-Ver or other kind of versioning strategy. It’s a lot of work, and it’s a lot of time.

Release Agent closes that gap. It watches merged PRs, understands conventional commits,
reads linked ticket references, and generates a human-readable release report with an
AI-reasoned version bump recommendation. The engineering lead reviews, overrides if needed,
and approves with a slash command. The agent executes everything: changelog, version bump,
git tag, GitHub release, PR with changes.

### Core Design Principles

1. **GitHub-native** — the entire UX lives inside GitHub (issues, PR comments, slash commands).
   No external dashboard. No separate login.
2. **Transparent AI** — the agent always explains _why_ it suggests a version bump.
   Humans stay in control. `/approve` is always required.
3. **Zero-config start** — works with conventional commits out of the box. Optional
   `.release-agent.md` for customization. No YAML files.
4. **Stateless by design** — GitHub is the state store. No database required for MVP.
   Git tags = last release. Repo files = config. Repo secrets = AI API key.
5. **BYOK (Bring Your Own Key)** — OpenAI-compatible API. Any provider works
   (OpenAI, Anthropic, Groq, Ollama, etc). Users own their AI usage and cost.
6. **Open-core, MIT licensed** — CLI and Action are free forever. Hosted GitHub App
   is free for OSS repos. Private repos require a subscription (post-MVP).

### Target Persona

An engineering lead managing a team of 3–10 developers. The team uses GitHub,
follows conventional commits (loosely), and ships on a sprint-based or ad-hoc schedule.
They have a `main` branch, possibly a `staging` branch, and some form of CI via
GitHub Actions. They may or may not use a monorepo.

---

## 2. MVP Scope

### In Scope (MVP)

- GitHub App (Probot-based) that listens to PR and issue comment webhooks
- Slash command `/release-report` to generate a release report on-demand
- Slash command `/approve [patch|minor|major]` to trigger a release
- AI-generated release report with version bump suggestion and reasoning
- Conventional commits parsing (type, scope, breaking changes)
- JIRA / Linear / GitHub Issues ticket number extraction from PR descriptions (regex, no API)
- Single-repo changelog generation (CHANGELOG.md, Keep a Changelog format)
- Monorepo support: auto-detect pnpm/npm/yarn workspaces, Turborepo, Nx, Lerna;
  per-package versioning and changelogs
- GitHub Action that executes the release: version bump, CHANGELOG.md write,
  git tag, GitHub release creation, open PR with changes
- OpenAI-compatible AI integration (configurable provider, base URL, model)
- `.release-agent.md` config file support (natural language, Markdown)
- Dry-run mode (`/approve --dry-run`)
- Draft release mode (`/approve --draft`)
- Stateless architecture (no database, GitHub is the state store)
- Self-hostable GitHub App (Docker image provided)

### Out of Scope (MVP — future phases)

- JIRA / Linear API integration (just read ticket numbers from PR text for now)
- Slack / MS Teams / Discord / email notifications
- Web dashboard
- Rollback monitoring
- Automated post-release health checks
- GitLab / Bitbucket support
- Billing / subscription enforcement (build audience first)
- Custom webhook integrations

---

## 3. Architecture

### System Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│  GitHub                                                              │
│                                                                      │
│   PR merged ──────────────────────────────► Bot receives webhook    │
│                                              (logs PR silently)     │
│                                                                      │
│   Lead comments                                                      │
│   /release-report ────────────────────────► Bot reads PRs since     │
│   on any issue                               last tag via GitHub API │
│                                              Parses commits          │
│                                              Calls AI for report     │
│                                              Posts report comment ◄──┘
│
│   Lead reviews report,
│   comments /approve minor ────────────────► Bot validates command
│                                              Triggers workflow_dispatch
│                                              on release-agent.yml
│
│   GitHub Action runs ─────────────────────► Bumps package.json(s)
│   in repo CI                                 Writes CHANGELOG.md
│                                              Commits changes
│                                              Creates git tag
│                                              Creates GitHub release
│                                              Opens PR to main
│                                              Posts completion comment
└──────────────────────────────────────────────────────────────────────┘
```

### Two Components

**Component 1: The Bot (GitHub App)**

- Built with Probot (Node.js/TypeScript framework for GitHub Apps)
- Runs as a persistent server, receives webhooks from GitHub
- Stateless — reads all state from GitHub API on demand
- Handles slash commands in issue comments
- Calls the AI to generate release reports
- Triggers the GitHub Action when approved
- Posts all feedback as GitHub issue/PR comments

**Component 2: The Action (GitHub Action)**

- A JavaScript GitHub Action (`action.yml`)
- Added to the user's repo as `.github/workflows/release-agent.yml`
- Triggered by the Bot via `workflow_dispatch` API call
- Receives the release plan as a JSON workflow input
- Executes the actual release: file changes, git operations, GitHub release
- Runs entirely within the user's GitHub Actions environment (their secrets, their runner)
- Posts a completion comment back to the release issue via the GitHub API

### How They Communicate

The Bot calls the GitHub API to trigger `workflow_dispatch` on the user's
`release-agent.yml` workflow. It passes the entire release plan as a JSON-encoded
string in the `release_plan` input. This decouples execution from intelligence:
the Bot does the thinking, the Action does the work.

```
Bot → POST /repos/{owner}/{repo}/actions/workflows/release-agent.yml/dispatches
      body: {
        ref: "main",
        inputs: {
          release_plan: "<JSON string>",
          issue_number: "42",
          dry_run: "false"
        }
      }
```

---

## 4. Tech Stack

### Root (Monorepo)

| Concern         | Choice                        | Reason                                   |
| --------------- | ----------------------------- | ---------------------------------------- |
| Package manager | pnpm                          | Efficient for monorepos, fast            |
| Workspace tool  | pnpm workspaces               | Minimal config, no extra tooling needed  |
| Language        | TypeScript (strict mode)      | Type safety across bot + action + shared |
| Build           | tsup                          | Fast, zero-config TS bundler             |
| Lint            | ESLint + `@typescript-eslint` | Standard TS linting                      |
| Format          | Prettier                      | Consistent formatting                    |
| Test            | Vitest                        | Fast, TS-native test runner              |
| Runtime         | Node.js ≥ 24                  | LTS, native fetch, `using` keyword       |

### Bot App (`apps/bot`)

| Concern              | Choice                               | Reason                                                  |
| -------------------- | ------------------------------------ | ------------------------------------------------------- |
| GitHub App framework | Probot v14                           | Battle-tested, TypeScript native, handles auth/webhooks |
| GitHub API client    | `@octokit/rest` (via Probot context) | Provided by Probot                                      |
| Commit parser        | `conventional-commits-parser`        | Official parser, handles all edge cases                 |
| Changelog writer     | `conventional-changelog-writer`      | Pairs with the parser, Keep a Changelog format          |
| Markdown parser      | `remark` + `remark-parse`            | For reading `.release-agent.md` config                  |
| AI client            | `openai` npm package                 | Supports any OpenAI-compatible base URL                 |
| Semver               | `semver`                             | Official semver library                                 |
| Schema validation    | `zod`                                | Runtime validation of release plan, config              |
| Logging              | `pino`                               | Fast structured logging                                 |
| HTTP server          | Built into Probot                    | No extra server needed                                  |

### Action (`apps/action`)

| Concern                | Choice                | Reason                                      |
| ---------------------- | --------------------- | ------------------------------------------- |
| GitHub Actions toolkit | `@actions/core`       | Input/output/logging primitives             |
| GitHub API             | `@actions/github`     | Authenticated Octokit for Actions           |
| Git operations         | `simple-git`          | Typed git wrapper, handles all git commands |
| File operations        | Node.js `fs/promises` | Native, no extra dep needed                 |
| Semver                 | `semver`              | Same as bot                                 |
| Schema validation      | `zod`                 | Validate release plan input                 |

### Shared (`packages/shared`)

| Concern               | Choice                                                |
| --------------------- | ----------------------------------------------------- |
| TypeScript interfaces | All shared types (ReleasePlan, ParsedPR, etc.)        |
| Utilities             | Ticket extraction regex, conventional commit type map |

---

## 5. Repository Structure

```
APP_NAME/
├── apps/
│   ├── bot/                              # GitHub App server
│   │   ├── src/
│   │   │   ├── index.ts                  # Probot entry point
│   │   │   ├── handlers/
│   │   │   │   ├── issue-comment.ts      # Slash command router
│   │   │   │   ├── pull-request.ts       # PR merged event handler
│   │   │   │   └── installation.ts       # App installed/uninstalled
│   │   │   ├── commands/
│   │   │   │   ├── release-report.ts     # /release-report logic
│   │   │   │   └── approve.ts            # /approve logic
│   │   │   ├── services/
│   │   │   │   ├── pr-reader.ts          # Fetch PRs since last tag
│   │   │   │   ├── commit-parser.ts      # Parse conventional commits
│   │   │   │   ├── monorepo-detector.ts  # Detect monorepo type + packages
│   │   │   │   ├── version-calculator.ts # Calculate next semver
│   │   │   │   ├── report-generator.ts   # AI report generation
│   │   │   │   ├── changelog-writer.ts   # CHANGELOG.md generation
│   │   │   │   └── config-reader.ts      # Read .release-agent.md
│   │   │   └── utils/
│   │   │       ├── github.ts             # GitHub API helpers
│   │   │       ├── comments.ts           # Comment template builders
│   │   │       └── permissions.ts        # Check actor permissions
│   │   ├── test/
│   │   │   ├── handlers/
│   │   │   ├── services/
│   │   │   └── fixtures/                 # Sample PR payloads, configs
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── .env.example
│   │
│   └── action/                           # GitHub Action executor
│       ├── src/
│       │   ├── main.ts                   # Action entry point
│       │   ├── release-executor.ts       # Orchestrates release steps
│       │   ├── steps/
│       │   │   ├── bump-version.ts       # Update package.json version(s)
│       │   │   ├── write-changelog.ts    # Write CHANGELOG.md
│       │   │   ├── git-operations.ts     # Commit, tag, push
│       │   │   ├── github-release.ts     # Create GitHub release via API
│       │   │   └── open-pr.ts            # Open changelog PR
│       │   └── utils/
│       │       └── monorepo.ts           # Monorepo package resolution
│       ├── test/
│       ├── action.yml                    # Action definition (inputs/outputs)
│       ├── package.json
│       └── tsconfig.json
│
├── packages/
│   └── shared/                           # Shared types + utilities
│       ├── src/
│       │   ├── types.ts                  # All shared TypeScript interfaces
│       │   ├── constants.ts              # Commit type → semver bump map, etc.
│       │   └── utils.ts                  # Ticket regex, slug helpers
│       ├── package.json
│       └── tsconfig.json
│
├── .github/
│   └── workflows/
│       ├── ci.yml                        # Test + lint on PR
│       └── release.yml                   # Release the agent itself
│
├── docs/
│   ├── getting-started.md
│   ├── configuration.md
│   ├── slash-commands.md
│   ├── monorepo.md
│   └── self-hosting.md
│
├── examples/
│   ├── single-repo/
│   │   └── .github/workflows/release-agent.yml
│   └── monorepo/
│       └── .github/workflows/release-agent.yml
│
├── .release-agent.md.example             # Example config file
├── docker-compose.yml                    # For self-hosting
├── Dockerfile                            # Bot server image
├── package.json                          # Root workspace
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .eslintrc.json
├── .prettierrc
├── vitest.config.ts
└── PLAN.md                               # This file
```

---

## 6. Shared TypeScript Types

All types live in `packages/shared/src/types.ts` and are imported by both `apps/bot`
and `apps/action`.

```typescript
// packages/shared/src/types.ts

export type CommitType =
  | "feat"
  | "fix"
  | "docs"
  | "style"
  | "refactor"
  | "perf"
  | "test"
  | "build"
  | "ci"
  | "chore"
  | "revert"
  | "breaking";

export type BumpType = "major" | "minor" | "patch" | "none";

export type MonorepoType =
  | "pnpm-workspaces"
  | "npm-workspaces"
  | "yarn-workspaces"
  | "turborepo"
  | "nx"
  | "lerna"
  | "none";

export interface ParsedCommit {
  type: CommitType;
  scope: string | null;
  subject: string;
  body: string | null;
  isBreaking: boolean;
  sha: string;
}

export interface ParsedPR {
  number: number;
  title: string;
  url: string;
  author: string;
  mergedAt: string; // ISO timestamp
  commits: ParsedCommit[];
  tickets: string[]; // ['PROJ-123', 'PROJ-456', '#42']
  suggestedBump: BumpType; // Derived from commits in this PR
  bodyExcerpt: string | null; // First 500 chars of PR description
}

export interface PackageInfo {
  name: string;
  path: string; // Relative path from repo root
  currentVersion: string;
  packageJsonPath: string;
  changelogPath: string;
  affectedPRs: ParsedPR[]; // PRs that touched this package
}

export interface MonorepoInfo {
  type: MonorepoType;
  packages: PackageInfo[];
  rootPackage: PackageInfo | null; // Root package.json if it has a version
}

export interface RepoConfig {
  branches: {
    production: string; // Default: 'main'
    staging: string | null; // Default: 'staging' (null if not defined)
    development: string | null; // Default: 'develop' (null if not defined)
  };
  preReleaseSuffix: {
    staging: string; // Default: 'rc'
    development: string; // Default: 'alpha'
  };
  releaseNotesStyle: string; // Natural language, passed to AI as context
  customContext: string; // Everything else from the config file
  rawContent: string; // Full .release-agent.md content
}

export interface ReleaseReport {
  repoOwner: string;
  repoName: string;
  baseBranch: string;
  lastTag: string | null; // null if first release
  lastTagDate: string | null;
  prs: ParsedPR[];
  suggestedBump: BumpType;
  suggestedVersion: string;
  currentVersion: string;
  reasoning: string; // AI-generated explanation
  changelogPreview: string; // Markdown formatted changelog draft
  isMonorepo: boolean;
  monorepoInfo: MonorepoInfo | null;
  generatedAt: string; // ISO timestamp
}

export interface ReleasePlan {
  // Set by bot when /approve is received
  repoOwner: string;
  repoName: string;
  baseBranch: string;
  bumpType: BumpType;
  currentVersion: string;
  nextVersion: string;
  lastTag: string | null;
  prs: ParsedPR[];
  changelogContent: string; // Final changelog Markdown to write
  isMonorepo: boolean;
  monorepoInfo: MonorepoInfo | null;
  isDraft: boolean;
  isDryRun: boolean;
  issueNumber: number; // The issue where /approve was commented
  approvedBy: string; // GitHub username who approved
  approvedAt: string; // ISO timestamp
}

export interface ReleaseResult {
  success: boolean;
  nextVersion: string;
  tagName: string;
  releaseUrl: string | null;
  prUrl: string | null;
  error: string | null;
  isDryRun: boolean;
}
```

---

## 7. Configuration — `.release-agent.md`

Users add this file to their repo root. It is entirely optional — the agent works
without it using smart defaults.

### Format

Plain Markdown. No YAML, no JSON. The bot reads it on every `/release-report` call.
Specific sections are parsed deterministically (branches); everything else is passed
verbatim to the AI as context.

### Example File

```markdown
# Release Agent Configuration

## Branches

- production: main
- staging: staging
- development: develop

## Pre-release Tags

- staging suffix: rc
- development suffix: alpha

## Release Notes Style

Write release notes for a technical audience. Be concise.
Group under: New Features, Bug Fixes, Maintenance.
Highlight any security-related fixes prominently.
When a ticket number is present, include it in brackets after the item.

## Scope Notes

This is a Node.js API service. Changes to `src/` affect the API.
Changes under `infra/` are infrastructure-only and should be noted as such.
The `packages/ui` package has its own release cycle — exclude from API releases.
```

### Parsing Logic (`apps/bot/src/services/config-reader.ts`)

1. Fetch `.release-agent.md` from repo root via GitHub API. If not found, return defaults.
2. Parse the `## Branches` section: look for `- production:`, `- staging:`, `- development:` lines.
3. Parse the `## Pre-release Tags` section similarly.
4. Everything else is stored as `customContext` and `releaseNotesStyle` strings.
5. Return a `RepoConfig` object.

### Defaults (when file is absent)

```typescript
const DEFAULT_CONFIG: RepoConfig = {
  branches: {
    production: "main",
    staging: "staging",
    development: "develop",
  },
  preReleaseSuffix: {
    staging: "rc",
    development: "alpha",
  },
  releaseNotesStyle: "",
  customContext: "",
  rawContent: "",
};
```

---

## 8. GitHub App Specification

### App Registration Settings

```
Name:         APP_NAME
Homepage:     https://github.com/APP_NAME/APP_NAME
Callback URL: https://<bot-host>/api/github/webhooks
Webhook URL:  https://<bot-host>/api/github/webhooks
Webhook Secret: <random 32 char string>

Permissions (Repository):
  - Contents: Read & Write         (read files, create commits/tags/releases)
  - Issues: Read & Write           (read and post comments)
  - Pull Requests: Read & Write    (read PRs, post comments)
  - Actions: Read & Write          (trigger workflow_dispatch)
  - Metadata: Read-only            (required by default)

Events to subscribe:
  - issue_comment                  (slash commands)
  - pull_request (closed)          (track merged PRs)
  - installation                   (install/uninstall events)
```

### Environment Variables (Bot)

```bash
# Required
APP_ID=<GitHub App ID>
PRIVATE_KEY=<GitHub App private key (PEM format)>
WEBHOOK_SECRET=<GitHub webhook secret>

# AI (Required for report generation)
AI_API_KEY=<OpenAI-compatible API key>
AI_BASE_URL=https://api.openai.com/v1   # Override for other providers
AI_MODEL=gpt-4o-mini                    # Override for other models

# Optional
PORT=3000
LOG_LEVEL=info
NODE_ENV=production
```

### Webhook Handlers

#### `pull_request.closed` (when `merged === true`)

File: `apps/bot/src/handlers/pull-request.ts`

This is a passive listener. When a PR is merged into a tracked branch, the bot
does NOT comment or take action. It simply validates the event and logs it.
No state is stored — the PR data will be fetched live when `/release-report` is called.

```typescript
app.on("pull_request.closed", async (context) => {
  const pr = context.payload.pull_request;
  if (!pr.merged) return;

  const config = await readConfig(context);
  const trackedBranches = [
    config.branches.production,
    config.branches.staging,
    config.branches.development,
  ].filter(Boolean);

  if (!trackedBranches.includes(pr.base.ref)) return;

  // Log for observability only. No action taken.
  context.log.info(
    {
      repo: context.repo(),
      pr: pr.number,
      branch: pr.base.ref,
      merged: true,
    },
    "PR merged into tracked branch",
  );
});
```

#### `issue_comment.created`

File: `apps/bot/src/handlers/issue-comment.ts`

Parses the comment body for slash commands. Ignores comments from bots.
Checks that the commenter has write access to the repo (collaborator or higher).

```typescript
app.on("issue_comment.created", async (context) => {
  const comment = context.payload.comment;
  const sender = context.payload.sender;

  // Ignore bot comments (prevents loops)
  if (sender.type === "Bot") return;

  // Check write permissions
  const hasPermission = await checkWritePermission(context, sender.login);
  if (!hasPermission) {
    await context.octokit.issues.createComment({
      ...context.repo(),
      issue_number: context.payload.issue.number,
      body: `@${sender.login} you need write access to this repository to use release commands.`,
    });
    return;
  }

  const body = comment.body.trim();

  if (body.startsWith("/release-report")) {
    await handleReleaseReport(context);
  } else if (body.startsWith("/approve")) {
    await handleApprove(context, body);
  }
});
```

#### `installation.created`

File: `apps/bot/src/handlers/installation.ts`

When the app is installed, post a welcome issue in the repo with setup instructions.
Include a checklist: add the workflow file, set the AI_API_KEY secret, optionally
add `.release-agent.md`.

---

## 9. Slash Commands — Full Specification

### `/release-report`

**Trigger:** Comment on any issue in the repo.
**Who:** Any user with repository write access.

**What happens:**

1. Bot posts a "Generating report..." acknowledgement comment immediately (shows the bot is alive).
2. Bot reads config from `.release-agent.md` (or uses defaults).
3. Bot calls `PRReader.getPRsSinceLastTag()`.
4. Bot calls `CommitParser.parsePRs()` on the result.
5. Bot detects monorepo type and maps PRs to packages.
6. Bot calculates suggested version bump.
7. Bot calls `ReportGenerator.generate()` — the AI step.
8. Bot edits the acknowledgement comment to replace it with the full report.

**Output format** (see Section 12 — Report Comment Template).

**Error handling:**

- If no PRs found since last tag → post "No changes detected since `vX.Y.Z`."
- If AI call fails → post report without AI reasoning, note that AI was unavailable.
- If no previous tag exists → treat as first release, suggest `v0.1.0`.

---

### `/approve [bump] [--draft] [--dry-run]`

**Trigger:** Comment on any issue in the repo.
**Who:** Any user with repository write access.

**Valid forms:**

```
/approve                   → use the suggested bump from last report
/approve patch             → force patch bump
/approve minor             → force minor bump
/approve major             → force major bump
/approve --draft           → create a draft GitHub release (not published)
/approve --dry-run         → simulate, post what would happen, do nothing
/approve minor --draft     → minor bump + draft release
```

**What happens:**

1. Bot posts acknowledgement: "Release `vX.Y.Z` is being prepared..."
2. Bot re-fetches PRs and recalculates (in case new PRs merged since last report).
3. Bot builds the `ReleasePlan` object.
4. Bot calls `ChangelogWriter.generate()` to produce the final CHANGELOG entry.
5. Bot triggers `workflow_dispatch` on the user's `release-agent.yml` workflow,
   passing the `ReleasePlan` as JSON in the `release_plan` input.
6. Bot updates its comment: "Release triggered — [workflow run link]".
7. Action runs in the repo's CI and posts a completion comment when done.

**Validation before triggering:**

- At least one PR must exist since the last tag.
- The release-agent.yml workflow must exist in the repo.
- The bot must have `Actions: Write` permission.

**Error handling:**

- If `release-agent.yml` not found → post setup instructions.
- If workflow dispatch fails → post error with link to docs.

---

### `/release-report --branch <branch>`

Optional override to generate a report for a non-default branch.

```
/release-report --branch staging   → report for staging branch
```

---

## 10. PR Reader Service

File: `apps/bot/src/services/pr-reader.ts`

### Responsibility

Fetch all merged PRs targeting the specified branch, from the last release tag
up to the current HEAD. Return raw PR data ready for parsing.

### Algorithm

```typescript
async function getPRsSinceLastTag(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
): Promise<RawPR[]> {
  // Step 1: Get the last release tag
  const lastTag = await getLastReleaseTag(octokit, owner, repo);

  // Step 2: Determine the cutoff date
  // If no tag exists, use repo creation date (first release)
  const since = lastTag
    ? await getTagCommitDate(octokit, owner, repo, lastTag.name)
    : null;

  // Step 3: List merged PRs targeting `branch`, newer than cutoff
  // Use GitHub Search API for efficiency
  const query = [
    `repo:${owner}/${repo}`,
    `is:pr`,
    `is:merged`,
    `base:${branch}`,
    since ? `merged:>${since}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const prs = await octokit.paginate(octokit.search.issuesAndPullRequests, {
    q: query,
    sort: "created",
    order: "asc",
    per_page: 100,
  });

  // Step 4: For each PR, fetch the full PR details + commits
  return Promise.all(
    prs.map((pr) => fetchPRWithCommits(octokit, owner, repo, pr.number)),
  );
}
```

### `getLastReleaseTag`

Fetches tags from the repo, filters to semver-compliant tags (regex: `/^v?\d+\.\d+\.\d+/`),
sorts by semver descending, returns the latest. Handles both `v1.0.0` and `1.0.0` formats.

### `getCurrentVersion`

Reads `package.json` (or root `package.json` for monorepos) from the default branch
via GitHub API. Falls back to parsing the latest git tag if `package.json` is absent.

---

## 11. Conventional Commits Parser Service

File: `apps/bot/src/services/commit-parser.ts`

### Conventional Commit Types → Semver Bump

```typescript
// packages/shared/src/constants.ts

export const COMMIT_TYPE_BUMP: Record<string, BumpType> = {
  feat: "minor", // New feature
  fix: "patch", // Bug fix
  perf: "patch", // Performance improvement
  revert: "patch", // Reverts a previous commit
  docs: "none", // Documentation only
  style: "none", // Formatting, whitespace
  refactor: "none", // Code refactor (no feature/fix)
  test: "none", // Adding/updating tests
  build: "none", // Build system changes
  ci: "none", // CI configuration
  chore: "none", // Other maintenance
};

// BREAKING CHANGE in footer OR `!` after type → always major
// e.g. `feat!: remove legacy API` or `feat(api): new endpoint\n\nBREAKING CHANGE: removes /v1`
```

### PR-Level Bump Calculation

For a given PR, the suggested bump is the highest bump across all its commits:

- Any commit with `BREAKING CHANGE` → `major` (short-circuits)
- Any `feat` commit → at least `minor`
- Any `fix`/`perf`/`revert` → at least `patch`
- All `chore`/`docs`/`style`/etc → `none`

### Repo-Level Bump Calculation

The final suggested bump across all PRs since the last tag follows the same rule:
take the highest bump type seen across all PRs.

### Ticket Extraction

Tickets are extracted from PR title and PR body using regex. No API calls.

```typescript
// packages/shared/src/utils.ts

export function extractTickets(text: string): string[] {
  const patterns = [
    /[A-Z]+-\d+/g, // JIRA: PROJ-123, ENG-456
    /[A-Za-z]+-\d+/g, // Linear: ENG-123
    /#(\d+)/g, // GitHub Issues: #42
  ];
  // Deduplicate results
}
```

### PR Title Fallback

If a PR's commits do not follow conventional commits, the bot attempts to parse
the PR title itself as a conventional commit. If that also fails, the PR is
categorized as `chore` with a `none` bump and flagged in the report:

> ⚠️ PR #42 "update stuff" does not follow conventional commits — categorized as chore.

---

## 12. Monorepo Detector Service

File: `apps/bot/src/services/monorepo-detector.ts`

### Detection Algorithm

The bot reads the following files from the repo root via GitHub API (one request each):

```
Priority order (first match wins):
1. pnpm-workspace.yaml          → MonorepoType: 'pnpm-workspaces'
2. turbo.json                   → MonorepoType: 'turborepo'
   (also check package.json#workspaces for package list)
3. nx.json                      → MonorepoType: 'nx'
4. lerna.json                   → MonorepoType: 'lerna'
5. package.json#workspaces      → MonorepoType: 'npm-workspaces' or 'yarn-workspaces'
   (check package.json#packageManager to distinguish)
6. (none of the above)          → MonorepoType: 'none' (single repo)
```

### Package Discovery

Once the monorepo type is identified, discover packages:

- **pnpm-workspaces**: Parse `packages:` array from `pnpm-workspace.yaml`.
  Glob patterns like `packages/*` → list matching directories containing `package.json`.
- **Turborepo / npm workspaces / yarn workspaces**: Read `workspaces` array from root `package.json`.
- **Nx**: Read `projects` from `nx.json` or scan `project.json` files.
- **Lerna**: Read `packages` from `lerna.json`.

For each discovered package path, fetch `package.json` to get `name` and `version`.

### Affected Package Resolution

For each PR, determine which packages it affects by looking at the changed files:

```typescript
async function getAffectedPackages(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  packages: PackageInfo[],
): Promise<PackageInfo[]> {
  const files = await octokit.pulls.listFiles({
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  return packages.filter((pkg) =>
    files.data.some((file) => file.filename.startsWith(pkg.path + "/")),
  );
}
```

A PR that touches `packages/api/src/auth.ts` is attributed to the `api` package.
A PR that touches `packages/shared/` is attributed to `shared`.
A PR that touches multiple packages is attributed to all of them.

### Per-Package Versioning

Each package gets its own bump calculation based only on PRs that affected it.
A `feat` in `packages/api` does not bump `packages/ui`.

---

## 13. Version Calculator Service

File: `apps/bot/src/services/version-calculator.ts`

### Single Repo

```typescript
import semver from "semver";

function calculateNextVersion(
  currentVersion: string,
  bumpType: BumpType,
  branch: string,
  config: RepoConfig,
): string {
  if (bumpType === "none") return currentVersion;

  const isStagingBranch = branch === config.branches.staging;
  const isDevBranch = branch === config.branches.development;

  if (isStagingBranch) {
    // e.g. 1.4.2 + minor → 1.5.0-rc.0
    const base = semver.inc(currentVersion, bumpType)!;
    return `${base}-${config.preReleaseSuffix.staging}.0`;
  }

  if (isDevBranch) {
    const base = semver.inc(currentVersion, bumpType)!;
    return `${base}-${config.preReleaseSuffix.development}.0`;
  }

  // Production branch: clean semver bump
  return semver.inc(currentVersion, bumpType)!;
}
```

### Monorepo

Same logic applied per-package, using each package's own `currentVersion`.

---

## 14. AI Report Generator Service

File: `apps/bot/src/services/report-generator.ts`

### AI Client Setup

```typescript
import OpenAI from "openai";

const ai = new OpenAI({
  apiKey: process.env.AI_API_KEY,
  baseURL: process.env.AI_BASE_URL ?? "https://api.openai.com/v1",
});

const MODEL = process.env.AI_MODEL ?? "gpt-4o-mini";
```

This supports any OpenAI-compatible provider. Users set:

- `AI_API_KEY` — their API key for their chosen provider
- `AI_BASE_URL` — override endpoint (Groq: `https://api.groq.com/openai/v1`,
  Ollama: `http://localhost:11434/v1`, Anthropic-compatible: as needed)
- `AI_MODEL` — the model to use (default: `gpt-4o-mini` for cost efficiency)

### System Prompt

```
You are a release manager assistant for software engineering teams.
You help generate clear, accurate release reports based on merged pull requests.
Be concise and technical. Do not embellish or invent features.
Only describe what is in the provided PR data.
```

### User Prompt Template

```typescript
function buildPrompt(prs: ParsedPR[], config: RepoConfig): string {
  return `
Generate a release report summary based on these merged pull requests.

## Merged PRs
${prs
  .map(
    (pr) => `
- PR #${pr.number}: ${pr.title} (by @${pr.author})
  Type: ${pr.commits.map((c) => c.type).join(", ")}
  Tickets: ${pr.tickets.join(", ") || "none"}
  ${pr.bodyExcerpt ? `Description: ${pr.bodyExcerpt}` : ""}
`,
  )
  .join("")}

## Suggested version bump: ${calculateBump(prs)}

## Repository context (from .release-agent.md):
${config.releaseNotesStyle || "Write clear, concise release notes for a developer audience."}
${config.customContext || ""}

## Your task
1. Write 2–3 sentences explaining WHY the suggested version bump is appropriate,
   referencing specific PRs by number.
2. Write a changelog preview in Keep a Changelog format (### Added, ### Fixed, ### Changed,
   ### Removed sections — only include sections with content).
   Each entry should be a single line. Reference PR numbers and ticket numbers where available.

Respond with valid JSON matching this schema:
{
  "reasoning": "<2-3 sentence explanation>",
  "changelogPreview": "<markdown formatted changelog>"
}
`.trim();
}
```

### Error Resilience

If the AI call fails (timeout, rate limit, invalid key), the report is still generated
but with `reasoning: "AI unavailable — manual review required"` and the changelog
preview is generated deterministically from the parsed commits instead.

---

## 15. Changelog Writer Service

File: `apps/bot/src/services/changelog-writer.ts`

### Format — Keep a Changelog

```markdown
## [1.5.0] - 2026-05-18

### Added

- OAuth2 PKCE support for enhanced security ([#342](link)) · PROJ-1201
- CSV export from the dashboard ([#331](link)) · PROJ-1165

### Fixed

- Token refresh race condition in auth flow ([#341](link)) · PROJ-1199
- Modal z-index on mobile Safari ([#337](link)) · PROJ-1180

### Changed

- Upgraded Node.js runtime to v22 ([#340](link))
```

### Changelog File Strategy

- If `CHANGELOG.md` exists: prepend the new entry after the `# Changelog` header line.
- If `CHANGELOG.md` does not exist: create it with a standard header and the first entry.
- For monorepos: each package gets its own `CHANGELOG.md` in its own directory,
  PLUS a root `CHANGELOG.md` that aggregates all package changes.

---

## 16. Report Comment Template

This is the Markdown comment the bot posts in response to `/release-report`.

````markdown
## Release report — generated by APP_NAME

**Since:** `v1.4.2` · April 28, 2026 &nbsp;|&nbsp; **Branch:** `main`
**PRs analyzed:** 12 &nbsp;|&nbsp; **Commits:** 34 &nbsp;|&nbsp; **Contributors:** 4

---

### ✨ New features · suggests `minor` bump

- Add OAuth2 PKCE support · [#342](url) · `PROJ-1201`
- Rate limiting per endpoint · [#339](url) · `PROJ-1188`
- Export data to CSV from dashboard · [#331](url) · `PROJ-1165`

### 🐛 Bug fixes

- Fix token refresh race condition · [#341](url) · `PROJ-1199`
- Fix modal z-index on mobile Safari · [#337](url) · `PROJ-1180`
- Return 404 on soft-deleted resources · [#333](url) · `PROJ-1170`

### 🔧 Chores & maintenance

- Upgrade to Node 22 · [#340](url)
- Add Playwright tests to CI pipeline · [#336](url)
- Remove deprecated v1 API endpoints · [#329](url)

---

### Recommendation

**Suggested bump:** `minor` → `v1.5.0`

> Two substantial new user-facing features (OAuth2 PKCE #342, CSV export #331) qualify
> this as a minor release per semver. No breaking changes detected. The fixes alone
> would have been a patch.

<details>
<summary>Changelog preview</summary>

```markdown
## [1.5.0] - 2026-05-18

### Added

- OAuth2 PKCE support ([#342](url)) · PROJ-1201
- Rate limiting per endpoint ([#339](url)) · PROJ-1188
- CSV export from dashboard ([#331](url)) · PROJ-1165

### Fixed

- Token refresh race condition ([#341](url)) · PROJ-1199
- Modal z-index on mobile Safari ([#337](url)) · PROJ-1180
- 404 on soft-deleted resources ([#333](url)) · PROJ-1170
```
````

</details>

---

Reply with a command to release:
`/approve` &nbsp; `/approve patch` &nbsp; `/approve minor` &nbsp; `/approve major` &nbsp; `/approve --draft` &nbsp; `/approve --dry-run`

````

> Note: The triple-backtick block inside the `<details>` is escaped in the actual template.
> Implement this using a template literal function in `apps/bot/src/utils/comments.ts`.

---

## 17. GitHub Action Specification

### `action.yml`

```yaml
name: 'APP_NAME Release Action'
description: 'Executes a release plan prepared by APP_NAME bot'
author: 'APP_NAME'

inputs:
  release_plan:
    description: 'JSON-encoded ReleasePlan object'
    required: true
  github_token:
    description: 'GitHub token with contents and pull-requests write permissions'
    required: true
  issue_number:
    description: 'Issue number to post completion comment to'
    required: false
    default: ''
  dry_run:
    description: 'If true, simulate all steps without making changes'
    required: false
    default: 'false'

outputs:
  version:
    description: 'The new version that was released'
  tag:
    description: 'The git tag that was created'
  release_url:
    description: 'URL of the created GitHub release'
  pr_url:
    description: 'URL of the opened changelog PR'

runs:
  using: 'node20'
  main: 'dist/index.js'
````

### Workflow File (Added to User's Repo)

Users add this file as `.github/workflows/release-agent.yml`:

```yaml
name: Release Agent

on:
  workflow_dispatch:
    inputs:
      release_plan:
        description: "Release plan (provided by APP_NAME bot)"
        required: true
        type: string
      issue_number:
        required: false
        type: string
        default: ""
      dry_run:
        required: false
        type: boolean
        default: false

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: ${{ secrets.GITHUB_TOKEN }}

      - uses: APP_NAME/release-agent-action@v1
        with:
          release_plan: ${{ inputs.release_plan }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          issue_number: ${{ inputs.issue_number }}
          dry_run: ${{ inputs.dry_run }}
```

### Release Execution Steps (`apps/action/src/release-executor.ts`)

The action runs these steps in sequence. Each step is a separate function.
Any step failure is caught, a failure comment is posted, and the action exits non-zero.

```
Step 1: Parse and validate the release_plan JSON input (zod schema)
Step 2: Configure git identity
        git config user.name "APP_NAME[bot]"
        git config user.email "APP_NAME[bot]@users.noreply.github.com"
Step 3: Bump version(s)
        Single repo: update package.json#version
        Monorepo: update each affected package's package.json#version
Step 4: Write CHANGELOG.md
        Single repo: prepend to ./CHANGELOG.md
        Monorepo: prepend to each package's CHANGELOG.md + root CHANGELOG.md
Step 5: Commit the changes
        git add -A
        git commit -m "chore(release): v{nextVersion} [skip ci]"
        The [skip ci] prevents the CI pipeline from triggering on this commit
Step 6: Create and push the git tag
        git tag -a v{nextVersion} -m "Release v{nextVersion}"
        git push origin HEAD
        git push origin v{nextVersion}
Step 7: Create GitHub release
        POST /repos/{owner}/{repo}/releases
        {
          tag_name: "v{nextVersion}",
          name: "v{nextVersion}",
          body: {changelogContent},
          draft: {isDraft},
          prerelease: {version contains -rc or -alpha}
        }
Step 8: Open a pull request with the changelog/version changes
        The commit in Step 5 is on a new branch: release/v{nextVersion}
        PR base: production branch
        PR title: "chore(release): v{nextVersion}"
        PR body: The changelog content
Step 9: Post completion comment to the release issue
        "Release v{nextVersion} complete! 🎉
         Tag: v{nextVersion}
         GitHub release: {releaseUrl}
         Changelog PR: {prUrl}"
```

> **Important for Step 5:** The release commit is made on a new branch
> `release/v{nextVersion}`, not directly on `main`. This gives the team a PR to
> review and merge, keeping the main branch protected. The git tag is created on
> this commit before the PR is merged. This is by design — the tag marks the exact
> code that was released.

### Dry Run Mode

When `dry_run: true`:

- All steps execute except Steps 5, 6, 7, 8 (no git writes, no GitHub writes)
- Instead, a detailed comment is posted showing exactly what would happen:
  the version bump diffs, the CHANGELOG entry, the tag that would be created

---

## 18. Permissions Check

File: `apps/bot/src/utils/permissions.ts`

Before handling any slash command, check that the commenter has at minimum
`write` access to the repository.

```typescript
async function checkWritePermission(
  context: Context,
  username: string,
): Promise<boolean> {
  const { data } = await context.octokit.repos.getCollaboratorPermissionLevel({
    ...context.repo(),
    username,
  });
  return ["write", "maintain", "admin"].includes(data.permission);
}
```

---

## 19. State Management

**The bot is completely stateless. No database.**

All state is derived from GitHub on demand:

| State                  | Source                                                            |
| ---------------------- | ----------------------------------------------------------------- |
| Current version        | `package.json` in repo (read via API)                             |
| Last release tag       | GitHub tags API, sorted by semver                                 |
| PRs since last release | GitHub Search API, filtered by `merged:>` date of last tag        |
| Repo config            | `.release-agent.md` in repo root (read via API)                   |
| AI API key             | `RELEASE_AGENT_AI_KEY` in repo secrets → passed as Action env var |
| Release history        | GitHub releases page (native GitHub feature)                      |
| Pending approval       | The release issue comment thread (native GitHub)                  |

The trade-off: every `/release-report` makes several GitHub API calls.
With 5,000 req/hr rate limit per installation, this is not a concern for
the target team size. A team doing 10 releases/day would use ~100 API calls total.

When the product grows to warrant it (many large repos, high release frequency),
a Redis cache layer can be added in front of the GitHub API calls without
changing the architecture.

---

## 20. Error Handling Strategy

### Bot

All webhook handlers are wrapped in try/catch. On any unhandled error:

1. Log the full error with `pino` (structured JSON).
2. Post a user-facing comment: "Something went wrong generating the report.
   Please try again or check the bot logs."
3. Never expose stack traces or internal errors in GitHub comments.

### Action

All steps are wrapped in try/catch. On step failure:

1. Log the error to Actions output.
2. Post a failure comment to the release issue (if `issue_number` was provided).
3. Exit with code 1 (marks the workflow run as failed).
4. Comment includes: which step failed, the error message, and a link to the
   workflow run for full logs.

### Idempotency

The action checks for an existing tag before creating one. If `v1.5.0` already
exists, it fails gracefully with: "Tag v1.5.0 already exists. Has this release
already been triggered?"

---

## 21. Development Setup

### Prerequisites

- Node.js 20+
- pnpm 9+
- A GitHub account

### Local Setup

```bash
git clone https://github.com/APP_NAME/APP_NAME
cd APP_NAME
pnpm install

# Copy and fill out environment variables
cp apps/bot/.env.example apps/bot/.env
```

### Running the Bot Locally

Use `smee.io` (or `ngrok`) to forward GitHub webhooks to localhost.

```bash
# Install smee client
npm install -g smee-client

# Start webhook proxy (get URL from smee.io)
smee -u https://smee.io/YOUR_CHANNEL -t http://localhost:3000/api/github/webhooks

# Start the bot in dev mode (watches for changes)
pnpm --filter bot dev
```

Set `WEBHOOK_PROXY_URL` in `apps/bot/.env` to the smee URL.
When running locally, Probot will automatically use this URL as the webhook endpoint.

### Running the Action Locally

Use `act` (https://github.com/nektos/act) to run GitHub Actions locally.

```bash
# Install act, then:
cd apps/action
pnpm build
act workflow_dispatch -e .github/test-event.json
```

### Building

```bash
pnpm build              # Build all apps and packages
pnpm --filter bot build
pnpm --filter action build
```

### Testing

```bash
pnpm test               # Run all tests
pnpm --filter bot test
pnpm --filter action test
```

---

## 22. Deployment (Bot Server)

### Dockerfile

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/bot/package.json ./apps/bot/
COPY packages/shared/package.json ./packages/shared/
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter bot build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/apps/bot/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

### Docker Compose (Self-Hosting)

```yaml
# docker-compose.yml
version: "3.8"
services:
  bot:
    build: .
    ports:
      - "3000:3000"
    environment:
      APP_ID: ${APP_ID}
      PRIVATE_KEY: ${PRIVATE_KEY}
      WEBHOOK_SECRET: ${WEBHOOK_SECRET}
      AI_API_KEY: ${AI_API_KEY}
      AI_BASE_URL: ${AI_BASE_URL:-https://api.openai.com/v1}
      AI_MODEL: ${AI_MODEL:-gpt-4o-mini}
      PORT: 3000
    restart: unless-stopped
```

### Railway (Hosted SaaS)

The bot server is deployed on Railway. Connect the GitHub repo, set environment
variables in Railway's dashboard, and deploy. Railway auto-deploys on push to main.
Use Railway's built-in HTTPS URL as the GitHub App webhook URL.

---

## 23. Testing Strategy

### Bot Unit Tests

- `commit-parser.test.ts` — test all commit type mappings, breaking change detection,
  PR title fallback, ticket extraction
- `version-calculator.test.ts` — test all bump combinations, pre-release suffix logic,
  first-release edge case
- `monorepo-detector.test.ts` — mock GitHub API responses for each monorepo type,
  test affected package resolution
- `config-reader.test.ts` — test config parsing with various .release-agent.md formats,
  test defaults when file is absent
- `report-generator.test.ts` — mock AI responses, test fallback when AI unavailable

### Bot Integration Tests (with fixtures)

- Provide sample GitHub webhook payloads in `apps/bot/test/fixtures/`
- Test full slash command handler flows with mocked Octokit

### Action Unit Tests

- `bump-version.test.ts` — test package.json version bumping, monorepo multi-bump
- `write-changelog.test.ts` — test prepend logic, file creation when absent
- `git-operations.test.ts` — test git command sequences

### End-to-End (Manual)

Use the local dev setup (smee + bot) against a test GitHub repo to verify:

1. `/release-report` posts a valid report comment
2. `/approve minor` triggers the workflow
3. Workflow runs, creates tag, opens PR
4. Dry run posts accurate simulation comment

---

## 24. Phased Roadmap

### Phase 1 — MVP (Build This First)

Everything described in this document. Definition of done:

- [ ] Bot deployed to Railway, installable as a GitHub App
- [ ] `/release-report` works end-to-end on a single-repo JS project
- [ ] `/approve` triggers the action and creates a real GitHub release
- [ ] Monorepo support (pnpm workspaces) works
- [ ] Self-hosting works via Docker Compose
- [ ] README with setup instructions in under 5 minutes

### Phase 2 — Post-Validation

Add these after getting feedback from real users:

- **JIRA / Linear API integration** — enrich ticket numbers with actual title/status
- **Slack notifications** — post release summary to a channel after production release
- **GitHub App Marketplace listing** — proper marketplace presence
- **Support for more monorepo tools** — Nx, Lerna, Yarn workspaces
- **GitLab support** — expand beyond GitHub
- **Release templates** — customizable changelog entry formats

### Phase 3 — SaaS Tier

- **Web dashboard** — release history, team activity, per-repo settings UI
- **Billing** — free for OSS + 3 private repos; paid for unlimited private repos
- **Cross-repo dependency awareness** — notify downstream repos when a library releases
- **Post-release monitoring hooks** — webhook to check error rates after release

---

## 25. Known Decisions & Constraints

| Decision                                           | Rationale                                                                                                                                                      |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Probot for GitHub App                              | Battle-tested, TypeScript-native, used by changeset-bot. Handles auth, webhooks, installation out of the box.                                                  |
| No database in MVP                                 | Removes all infra overhead. GitHub API is sufficient for the target team size. Can add Redis/Postgres in Phase 2.                                              |
| OpenAI-compatible API (not locked to one provider) | Users have different provider preferences and existing credits. The `openai` npm package supports any OpenAI-compatible base URL.                              |
| Action triggers via `workflow_dispatch`            | Keeps execution inside the user's environment (their secrets, their runners, their audit log). The bot never pushes commits directly.                          |
| Release on a new branch, not direct push to main   | Preserves branch protection rules. Most teams protect `main`. Opening a PR also gives a human review point.                                                    |
| `gpt-4o-mini` as default model                     | Cost-efficient. Report generation is a lightweight task — summarizing PRs, not complex reasoning. Users can upgrade to GPT-4o or Claude Sonnet via `AI_MODEL`. |
| pnpm workspaces for the project itself             | Efficient, fast, handles shared packages cleanly.                                                                                                              |
| Stateless bot, action does the writes              | Clean separation of concerns. The bot is read-only with intelligence; the action is write-only execution.                                                      |
| `[skip ci]` on release commit                      | Prevents CI loops. The release commit should not re-trigger the test suite.                                                                                    |
| MIT license                                        | Maximizes adoption. Self-hosting is a feature, not a threat. Revenue comes from the hosted service, not from restricting self-hosting.                         |

---

## 26. Key File Implementation Notes for Claude

When implementing, follow this order:

1. **Set up the monorepo scaffolding** — `pnpm-workspace.yaml`, root `package.json`,
   `tsconfig.base.json`, shared `packages/shared`.

2. **Implement `packages/shared`** — all types and constants first, before any app code.
   Everything else depends on this.

3. **Implement bot services in isolation** (no Probot yet):
   - `commit-parser.ts` (pure functions, easy to test)
   - `version-calculator.ts` (pure functions)
   - `monorepo-detector.ts` (mocked octokit in tests)
   - `pr-reader.ts` (mocked octokit in tests)
   - `config-reader.ts`
   - `changelog-writer.ts`
   - `report-generator.ts` (mock AI in tests)

4. **Wire up Probot** — implement handlers that call the services.
   `issue-comment.ts` → `commands/release-report.ts` + `commands/approve.ts`.

5. **Implement the Action** — `action.yml` + `release-executor.ts` + all steps.

6. **Write tests** as you go for each service.

7. **Dockerfile + docker-compose** last, once the app runs locally.

Do not use `any` TypeScript types anywhere. Enable `strict: true` in all `tsconfig.json`
files. All async functions should have explicit return types. Prefer `unknown` over `any`
when a type is truly unknown, and narrow it before use.
