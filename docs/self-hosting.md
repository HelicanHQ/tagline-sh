# Self-hosting

Tagline is MIT-licensed and self-hosting is a first-class path. The bot is a stateless Node server; the action runs inside your CI. There's no database to operate.

## What you're standing up

Only the **bot server**. The action is published as `HelicanHQ/tagline-release-agent-action` and runs in users' CI runners — you don't host it.

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

### With Railway

Railway is the recommended hosted target — Tagline ships a [`railway.json`](../railway.json) that points at the same `Dockerfile`, so you get the same multi-stage build the Compose path uses, with a managed TLS endpoint and zero infrastructure to operate.

1. **Fork or clone** this repo into your own GitHub account or organisation.
2. **Create a Railway project** at <https://railway.app/new> → "Deploy from GitHub repo" → pick your fork. Railway will detect `railway.json` and use the Dockerfile.
3. **Set the variables** in the Railway project's **Variables** tab:

    | Variable | Value |
    |----------|-------|
    | `APP_ID` | From your GitHub App settings page |
    | `PRIVATE_KEY` | Paste the full PEM **including** the `-----BEGIN/END-----` lines. Railway's variable input accepts multi-line values verbatim — no escaping, no `\n` substitution. |
    | `WEBHOOK_SECRET` | The 32+ random byte string you registered with the GitHub App |
    | `AI_API_KEY` | Your OpenAI-compatible API key (OpenRouter, OpenAI, Groq, etc.) |
    | `AI_BASE_URL` *(optional)* | Defaults to `https://openrouter.ai/api/v1`. Override per provider — see [BYOK for the AI](#byok-for-the-ai). |
    | `AI_MODEL` *(optional)* | Defaults to `openai/gpt-4o-mini`. |
    | `LOG_LEVEL` *(optional)* | `info` in steady state; `debug` while bringing up. |

    Do **not** set `PRIVATE_KEY_PATH` on Railway — that path is the Docker Compose secret-file convention. Railway has no file-mount primitive, so the bot reads the PEM straight from `PRIVATE_KEY`. Setting both will cause `PRIVATE_KEY_PATH` to win and break startup.

4. **Generate a public domain** under the service's **Settings → Networking → Generate Domain**. Copy the resulting `https://<your-app>.up.railway.app` URL.
5. **Point the GitHub App webhook** at `<railway-url>/api/github/webhooks` (Settings → your App → Webhook URL).
6. **Verify the deploy.** Railway probes `/ping` (configured in `railway.json`) — Probot's built-in liveness route returns `PONG` with HTTP 200. Once that responds, the deploy goes live. Tail logs via `railway logs` or the dashboard; you should see `INFO: Listening on http://:3000`.
7. **Send a test webhook delivery** from the GitHub App's "Advanced" tab and confirm a 2xx response within ~5 seconds. GitHub abandons webhooks that don't ack in 10s.

The Dockerfile's restart policy is governed by `railway.json` (`ON_FAILURE`, max 10 retries) — a crash loop stops after 10 attempts instead of churning indefinitely.

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

Use your GitHub App's install URL: `https://github.com/apps/<your-app-name>`. Pick the repos to install on. The bot will open a `Configure Tagline` pull request on each — review, edit `.release-agent.md` to taste, follow the embedded workflow-file instructions, and merge.

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
