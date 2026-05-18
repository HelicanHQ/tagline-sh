# Tagline

GitHub-native release-management agent. Reads merged PRs since the last tag, classifies them by conventional commit type, suggests a version bump with reasoning, and — once approved with a slash command — executes the release: bumps versions, writes `CHANGELOG.md`, creates the git tag, publishes the GitHub release, and opens a PR with the changes.

**Status:** pre-MVP. See [`PLAN.md`](./PLAN.md) for the full spec.

## Architecture

Two components communicating via `workflow_dispatch`:

- **`apps/bot`** — stateless Probot GitHub App. Reads state from GitHub on demand, parses commits, calls an OpenAI-compatible LLM, posts comments. Never writes to user repos.
- **`apps/action`** — Node 20 GitHub Action triggered by the bot. Runs in the user's CI environment with their secrets and performs all writes.
- **`packages/shared`** — TypeScript types, constants, and zod schemas shared by both apps.

## Slash commands

```
/release-report           # generate a release report
/approve                  # release with the suggested bump
/approve patch|minor|major
/approve --draft
/approve --dry-run
```

## Local development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

See `apps/bot/README.md` (coming in Phase 4) for the smee.io webhook proxy setup.

## License

MIT — see [LICENSE](./LICENSE).
