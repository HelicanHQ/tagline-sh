import type { Probot } from 'probot';
import { register as registerIssueComment } from './handlers/issue-comment.js';
import { register as registerPullRequest } from './handlers/pull-request.js';
import { register as registerInstallation } from './handlers/installation.js';
import { APP_DISPLAY_NAME } from '@tagline-sh/shared';

/**
 * Probot app entry point. Probot invokes this with an `app` instance once the
 * GitHub App handshake and webhook server are ready.
 *
 * Run locally with smee:
 *   pnpm --filter @tagline-sh/bot build
 *   pnpm --filter @tagline-sh/bot dev
 *
 * See apps/bot/README.md for the full setup.
 */
const app = (app: Probot): void => {
    app.log.info(`${APP_DISPLAY_NAME} bot ready — listening for webhooks.`);

    registerIssueComment(app);
    registerPullRequest(app);
    registerInstallation(app);
};

export default app;
