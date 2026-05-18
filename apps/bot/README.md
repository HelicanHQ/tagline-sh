# `@tagline-sh/bot`

Probot-based GitHub App that handles `/release-report` and `/approve` slash commands.

## Local development

You need:

1. A personal GitHub App pointing webhooks at a [smee.io](https://smee.io) channel.
2. The smee CLI to forward webhooks to `http://localhost:3000/api/github/webhooks`.

### Steps

```bash
# 1. Create a smee channel
npx smee-client --url https://smee.io/<YOUR_CHANNEL> --target http://localhost:3000/api/github/webhooks

# 2. Register a GitHub App at https://github.com/settings/apps/new
#    - Webhook URL: https://smee.io/<YOUR_CHANNEL>
#    - Webhook secret: any random string
#    - Permissions (Repository):
#        Contents: Read & Write
#        Issues: Read & Write
#        Pull Requests: Read & Write
#        Actions: Read & Write
#        Metadata: Read-only
#    - Events: issue_comment, pull_request, installation
#    Then generate a private key and copy values into the env.

# 3. Copy .env.example to .env and fill in:
cp .env.example .env

# 4. Build and start
pnpm --filter @tagline-sh/bot build
pnpm --filter @tagline-sh/bot dev

# 5. Install the App on a test repo
#    Visit https://github.com/apps/<your-app-name> and click "Install".
```

### Running tests

```bash
pnpm --filter @tagline-sh/bot test
```

All bot logic is covered by unit tests. The handlers use a synthetic `Context`
so no smee or live API is needed for the suite.

## Architecture

This package is **read-only** against GitHub. The bot never writes to user
repos — only the `@tagline-sh/action` does, via `workflow_dispatch`. See
[`PLAN.md`](../../PLAN.md) for the full architecture.
