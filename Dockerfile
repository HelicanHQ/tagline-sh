# syntax=docker/dockerfile:1.7
# Multi-stage build for the Tagline bot server.
#
# Stage 1 — builder: install deps + build the bot bundle.
# Stage 2 — runner: minimal runtime image with just the prod deps and the dist/.

FROM node:24-alpine AS builder
WORKDIR /app

# Enable pnpm via corepack with the pinned version from package.json.
RUN corepack enable

# Copy manifests first for better layer caching.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/bot/package.json ./apps/bot/
COPY apps/action/package.json ./apps/action/

RUN pnpm install --frozen-lockfile

# Now copy sources and build only the bot + its dependencies.
COPY packages ./packages
COPY apps/bot ./apps/bot

RUN pnpm --filter @tagline-sh/shared build && pnpm --filter @tagline-sh/bot build

# Prune devDependencies for the runtime image.
#
# `--legacy` is mandatory under pnpm v10. By default pnpm v10 only deploys from
# workspaces with `inject-workspace-packages=true`; without that, deploy exits 1
# with ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE and the runtime stage ends up
# missing both node_modules and dist/. Setting inject-workspace-packages
# globally would change resolution semantics for every dev-time `pnpm install`,
# so we scope the relaxation to this one deploy call instead.
RUN pnpm --filter @tagline-sh/bot --prod deploy --legacy /pruned


FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Drop privileges — Probot listens on a non-privileged port.
RUN addgroup -S tagline && adduser -S -G tagline tagline
USER tagline

COPY --from=builder --chown=tagline:tagline /pruned/dist ./dist
COPY --from=builder --chown=tagline:tagline /pruned/node_modules ./node_modules
COPY --from=builder --chown=tagline:tagline /pruned/package.json ./package.json

EXPOSE 3000
# Invoke probot's real JS entry directly, NOT the `.bin/probot` shim.
#
# pnpm deploy --legacy produces a shell-script shim at node_modules/.bin/probot
# (starts with `#!/bin/sh` then `basedir=$(...)`). The shim works under any
# shell (it's how `pnpm dev` resolves `probot run` locally), but Docker's
# exec-form CMD bypasses shells entirely — `execve("node", [".bin/probot", ...])`
# hands the shell script to Node which then SyntaxErrors on line 2's
# `basedir=$(...)`. The container then crash-loops and Railway's /ping never
# resolves. Calling the real JS file (which has its own `#!/usr/bin/env node`
# shebang) sidesteps the shim entirely.
CMD ["node", "node_modules/probot/bin/probot.js", "run", "./dist/index.js"]
