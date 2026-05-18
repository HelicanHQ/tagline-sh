# Self-hosting

Tagline is MIT-licensed and self-hosting is a first-class path. The bot is a stateless Node server; the action runs inside your CI. There's no database to operate.

## What you're standing up

Only the **bot server**. The action is published as `tagline-sh/release-agent-action` and runs in users' CI runners — you don't host it.

## Step 1 — register a GitHub App

Create a GitHub App at <https://github.com/settings/apps/new>.

| Field | Value |
|-------|-------|
| Name | Whatever you like (e.g. `mycorp-tagline`) |
| Webhook URL | The public URL of your bot server + `/api/github/webhooks` |
| Webhook secret | Any random 32-char string — save it |
| Repository permissions | `Contents: Read & Write`, `Issues: Read & Write`, `Pull Requests: Read & Write`, `Actions: Read & Write`, `Metadata: Read` |
| Events | `issue_comment`, `pull_request`, `installation` |

After creation, generate a private key (`.pem` file) and copy the App ID.

## Step 2 — run the bot

### With Docker Compose

The repo ships a [`docker-compose.yml`](../docker-compose.yml) that wraps the multi-stage [`Dockerfile`](../Dockerfile).

```bash
cp apps/bot/.env.example .env
# Fill in APP_ID, PRIVATE_KEY (single-line PEM), WEBHOOK_SECRET, AI_API_KEY

docker compose up -d --build
```

The container listens on port 3000 by default. Front it with your reverse proxy of choice (Caddy, nginx, Traefik) terminated with HTTPS, since GitHub webhooks require a public HTTPS endpoint.

### Without Docker

```bash
pnpm install
pnpm --filter @tagline-sh/shared build
pnpm --filter @tagline-sh/bot build
APP_ID=... PRIVATE_KEY=... WEBHOOK_SECRET=... AI_API_KEY=... \
  pnpm --filter @tagline-sh/bot start
```

Use any process supervisor (`systemd`, `pm2`, `tmux`) to keep it alive.

## Step 3 — install on your repos

Use your GitHub App's install URL: `https://github.com/apps/<your-app-name>`. Pick the repos to install on. The bot will post a welcome issue with the setup checklist.

## Operations

### Logs

The bot logs structured JSON via [pino](https://getpino.io). Set `LOG_LEVEL=debug` for verbose output during setup, `info` in steady state. In development (`NODE_ENV=development`) logs are pretty-printed via `pino-pretty`.

### Updates

```bash
git pull
docker compose up -d --build      # Docker
# or
pnpm install && pnpm build && systemctl restart tagline   # bare-metal
```

The bot is stateless, so restarts have zero data implications. In-flight webhooks get retried by GitHub.

### Scaling

A single bot pod can comfortably serve thousands of repos. Each `/release-report` is a handful of GitHub API calls plus one AI call — well under a second of CPU. If you ever need to scale, run multiple instances behind a load balancer; webhook deliveries are stateless.

### Rate limits

The hosted GitHub App rate limit is 5,000 requests/hour per installation. A team doing 10 releases/day spends ~100 requests total. Even very active repos won't approach the limit.

If you do hit it, the only mitigation that doesn't change the architecture is a Redis cache in front of the GitHub API. That's deliberately out of MVP scope.

## BYOK for the AI

`AI_API_KEY` is set on the **bot server**, not in user repos. If you're running Tagline as a shared instance for multiple teams, you bear the AI cost. If you'd rather pass through, expose your bot server to one team at a time — there's no multi-tenant billing in the MVP.

Tagline supports any OpenAI-compatible endpoint via `AI_BASE_URL`. Tested:

- OpenAI (default base URL: `https://api.openai.com/v1`)
- OpenRouter (the documented default: `https://openrouter.ai/api/v1`)
- Groq (`https://api.groq.com/openai/v1`)
- Ollama (`http://localhost:11434/v1`) — free & local but report quality drops sharply.

## Security checklist

- [ ] Webhook secret is 32+ random bytes and matches both the GitHub App and `WEBHOOK_SECRET`.
- [ ] Private key file is mode `0600`, not in version control.
- [ ] Bot endpoint is HTTPS only. Probot rejects HTTP webhooks anyway, but your proxy should redirect.
- [ ] The host can reach `api.github.com` and your AI provider; nothing else needs egress.
- [ ] No inbound ports other than `443` exposed to the internet.
