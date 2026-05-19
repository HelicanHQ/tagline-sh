import type { Context, Probot } from 'probot';
import { readRepoConfig } from '~/app/services';
import { OctokitGitHubReader, type ReaderOctokit } from '~/app/services/octokit-reader';

// See note in handlers/issue-comment.ts on the Octokit type adapter.
const asReader = (octokit: Context['octokit']): ReaderOctokit =>
    octokit as unknown as ReaderOctokit;

/**
 * Passive observer for merged PRs. Per PLAN.md §8 the bot does not act on this
 * event — it just logs for observability. State is rebuilt on demand when
 * `/release-report` is invoked, so there is nothing to write here.
 */
export async function handlePullRequestClosed(
    context: Context<'pull_request.closed'>,
): Promise<void> {
    const pr = context.payload.pull_request;
    if (!pr.merged) return;

    const reader = new OctokitGitHubReader(asReader(context.octokit));
    const config = await readRepoConfig(reader, context.repo());

    const tracked = [
        config.branches.production,
        config.branches.staging,
        config.branches.development,
    ].filter((b): b is string => Boolean(b));

    if (!tracked.includes(pr.base.ref)) return;

    context.log.info(
        {
            repo: context.repo(),
            pr: pr.number,
            branch: pr.base.ref,
        },
        'PR merged into tracked branch',
    );
}

export function register(app: Probot): void {
    app.on('pull_request.closed', handlePullRequestClosed);
}
