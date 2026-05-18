import { APP_DISPLAY_NAME, releaseTagName, type ReleasePlan } from '@tagline-sh/shared';

export interface CommentOctokit {
    rest: {
        issues: {
            createComment: (params: {
                owner: string;
                repo: string;
                issue_number: number;
                body: string;
            }) => Promise<{ data: { html_url: string } }>;
        };
    };
}

export interface CompletionContext {
    releaseUrl: string | null;
    prUrl: string | null;
    dryRun: boolean;
    /** When set, a step before completion failed; we post a failure comment instead. */
    error?: string;
}

/**
 * Comment back on the originating issue to close the slash-command loop.
 *
 * No-op when `plan.issueNumber === 0` (used by callers who triggered the
 * action without a bot-issued ack to attach to — e.g. `act` smoke tests).
 */
export async function postCompletionComment(
    plan: ReleasePlan,
    octokit: CommentOctokit,
    ctx: CompletionContext,
): Promise<void> {
    if (!plan.issueNumber) return;

    const tag = releaseTagName(plan.nextVersion);
    const body = ctx.error
        ? buildFailureBody(tag, ctx.error)
        : buildSuccessBody(tag, ctx);

    await octokit.rest.issues.createComment({
        owner: plan.repoOwner,
        repo: plan.repoName,
        issue_number: plan.issueNumber,
        body,
    });
}

function buildSuccessBody(tag: string, ctx: CompletionContext): string {
    if (ctx.dryRun) {
        return [
            `${APP_DISPLAY_NAME} dry-run complete for \`${tag}\`. No changes were made to the repo.`,
            '',
            'Review the report and approve again without `--dry-run` to ship it.',
        ].join('\n');
    }
    const lines = [`${APP_DISPLAY_NAME} released \`${tag}\` 🎉`, ''];
    if (ctx.releaseUrl) lines.push(`- GitHub release: ${ctx.releaseUrl}`);
    if (ctx.prUrl) lines.push(`- Changelog PR: ${ctx.prUrl}`);
    return lines.join('\n');
}

function buildFailureBody(tag: string, error: string): string {
    return [
        `${APP_DISPLAY_NAME} failed to release \`${tag}\`.`,
        '',
        '```',
        error,
        '```',
        '',
        'Check the workflow run for the full logs.',
    ].join('\n');
}
