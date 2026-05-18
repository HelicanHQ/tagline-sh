# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository status

This repo is **pre-implementation**. The only files are `package.json` (pnpm workspace root, `tagline-sh`) and `PLAN.md`. `PLAN.md` is the single source of truth for the MVP — every architectural decision, file path, type definition, and trade-off is documented there. Read it before writing code, and treat it as authoritative unless the user explicitly overrides a decision.

The package name in `package.json` is `tagline-sh`. `PLAN.md` uses the placeholder `APP_NAME` for the final product name — substitute `tagline-sh` (or whatever the user specifies) when implementing.

## Architecture (from PLAN.md)

The product is a GitHub-native release agent. It has **two components** that communicate via `workflow_dispatch`, never directly:

- **`apps/bot`** — a Probot v14 GitHub App. Stateless, read-only intelligence. Receives webhooks, parses commits, calls AI, posts comments. All state is derived from GitHub on demand (tags, PRs, `.release-agent.md` config in the repo). No database.
- **`apps/action`** — a Node 20 GitHub Action that does the write side. Triggered by the bot via `workflow_dispatch`, receives the full `ReleasePlan` as a JSON input, then bumps versions, writes `CHANGELOG.md`, commits, tags, opens a PR, and creates a GitHub release. Runs inside the user's CI with their secrets.
- **`packages/shared`** — TypeScript types + constants imported by both apps. Build this **first**; everything depends on it. `ReleasePlan` is the contract between bot and action.

Key architectural invariants — do not violate without explicit user direction:

- The bot **never writes** to user repos. Only the action does. This is what lets users keep branch protections and audit logs intact.
- The release commit lands on a new branch `release/v{nextVersion}` and is merged via PR — never pushed directly to `main`. The git tag is created on that commit *before* the PR is merged, because the tag marks the exact released code.
- The release commit message ends with `[skip ci]` to prevent CI loops.
- Slash commands (`/release-report`, `/approve`) are the only UX. There is no dashboard, no YAML config — `.release-agent.md` is the optional config and is Markdown, not YAML.
- AI provider is OpenAI-compatible via base-URL override. Do not hard-code OpenAI; users bring their own key for OpenAI/Anthropic/Groq/Ollama. Default model: `gpt-4o-mini`.
- If the AI call fails, the report is still generated deterministically from parsed commits with `reasoning: "AI unavailable — manual review required"`. AI is an enhancement, never a hard dependency.

## Tech stack (locked decisions)

| Layer | Choice |
|-------|--------|
| Package manager | `pnpm@10.22.0` (pinned via `packageManager` field) |
| Workspace | pnpm workspaces (no Turbo/Nx in the repo itself) |
| Language | TypeScript strict mode — **no `any`** anywhere; prefer `unknown` and narrow |
| Runtime | Node.js ≥ 24 for bot dev; Action targets Node 20 (`runs.using: node20`) |
| Build | tsup |
| Test | Vitest |
| Lint/Format | ESLint + `@typescript-eslint`, Prettier |
| Bot framework | Probot v14 |
| Schema validation | zod (validate `ReleasePlan` at the action boundary) |
| Commit parsing | `conventional-commits-parser` + `conventional-changelog-writer` |
| AI client | `openai` npm package (supports any OpenAI-compatible `baseURL`) |
| Logging | `pino` |
| Git ops in action | `simple-git` |

`PLAN.md §6` contains the full shared type definitions (`ParsedPR`, `MonorepoInfo`, `RepoConfig`, `ReleaseReport`, `ReleasePlan`, `ReleaseResult`) — copy them verbatim into `packages/shared/src/types.ts`.

## Commands

Once the workspace scaffolding exists, the planned commands are:

```bash
pnpm install                    # install all workspace deps
pnpm build                      # build all apps + packages
pnpm --filter bot build
pnpm --filter action build
pnpm test                       # run all Vitest suites
pnpm --filter bot test
pnpm --filter action test
pnpm --filter bot dev           # bot in watch mode (pair with smee)
```

Local bot dev uses `smee.io` to forward GitHub webhooks to `http://localhost:3000/api/github/webhooks`. Set `WEBHOOK_PROXY_URL` in `apps/bot/.env`. Local action runs use `act` against a test event file.

`pnpm test` currently exits 1 with "no test specified" — that's the placeholder script and is expected until tests are wired up.

## Implementation order (PLAN.md §26)

When asked to implement, follow this order — it reflects real dependencies, not preference:

1. Monorepo scaffolding (`pnpm-workspace.yaml`, `tsconfig.base.json`, root configs).
2. `packages/shared` — types and constants. Nothing else compiles without this.
3. Bot **services** as pure functions (test-first, no Probot yet): `commit-parser`, `version-calculator`, `monorepo-detector`, `pr-reader`, `config-reader`, `changelog-writer`, `report-generator`.
4. Probot wiring (`apps/bot/src/index.ts`, `handlers/`, `commands/`) that calls those services.
5. Action (`apps/action/action.yml` + `release-executor.ts` + `steps/`).
6. Dockerfile + docker-compose for self-hosting.

Services in step 3 should be implementable and testable with mocked Octokit before any webhook plumbing exists.

## Conventions worth knowing

- Commit-type → bump map is defined in `PLAN.md §11` (`feat` → minor, `fix`/`perf`/`revert` → patch, `BREAKING CHANGE` or `!` → major, everything else → none). Repo-level bump = max bump across PRs since last tag.
- Ticket extraction is **regex-only** in the MVP (`[A-Z]+-\d+` for JIRA/Linear, `#\d+` for GitHub Issues). No JIRA/Linear API calls.
- Monorepo detection priority: `pnpm-workspace.yaml` → `turbo.json` → `nx.json` → `lerna.json` → `package.json#workspaces`. First match wins.
- Pre-release versioning: staging branch → `-rc.N` suffix, dev branch → `-alpha.N` suffix, production → clean semver.
- Permission check before any slash command: actor must have `write`/`maintain`/`admin` on the repo.
- The report comment template in `PLAN.md §16` is the exact target output — replicate it via a template function in `apps/bot/src/utils/comments.ts`.
