import type { Context, Probot } from 'probot';
import { welcomeIssue } from '../utils/comments.js';

/**
 * On app installation, open a welcome issue with the setup checklist in each
 * newly-installed repository. The issue serves as a permanent reference point
 * teams can come back to.
 */
export async function handleInstallationCreated(
    context: Context<'installation.created'>,
): Promise<void> {
    const repos = context.payload.repositories ?? [];
    const owner = context.payload.installation.account.login;
    const { title, body } = welcomeIssue();

    for (const r of repos) {
        try {
            await context.octokit.rest.issues.create({
                owner,
                repo: r.name,
                title,
                body,
            });
        } catch (err) {
            context.log.error({ err, repo: r.name }, 'failed to open welcome issue');
        }
    }
}

export function register(app: Probot): void {
    app.on('installation.created', handleInstallationCreated);
}
