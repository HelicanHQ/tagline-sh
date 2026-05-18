import * as core from '@actions/core';
import { releaseBranchName, releaseTagName, type ReleasePlan, type ReleaseResult } from '@tagline-sh/shared';
import { bumpVersion } from './steps/bump-version.js';
import { writeChangelog } from './steps/write-changelog.js';
import { commitAndTag, type GitOpsDeps } from './steps/git-operations.js';
import { createGitHubRelease, type ReleaseOctokit } from './steps/github-release.js';
import { openReleasePR, type OpenPROctokit } from './steps/open-pr.js';
import { postCompletionComment, type CommentOctokit } from './steps/post-completion-comment.js';

/**
 * The intersection of every Octokit shape the steps need. We pass the same
 * authenticated client into every step that hits the GitHub API.
 */
export type ExecutorOctokit = ReleaseOctokit & OpenPROctokit & CommentOctokit;

export interface ExecutorDeps {
    octokit: ExecutorOctokit;
    workspaceRoot: string;
    git?: GitOpsDeps['git'];
}

/**
 * Run a release plan end-to-end against the file system + GitHub.
 *
 * Never throws — failures are captured into `ReleaseResult.error` and a
 * failure comment is posted on the originating issue. The caller (main.ts)
 * marks the workflow as failed via `core.setFailed()` based on the result.
 *
 * Dry-run mode (`plan.isDryRun`) short-circuits steps 5–8: it still bumps
 * versions and writes CHANGELOG.md on the filesystem (so the user can inspect
 * the diff in the workflow run logs), but skips git writes, GitHub release,
 * and PR creation.
 */
export async function executeRelease(
    plan: ReleasePlan,
    deps: ExecutorDeps,
): Promise<ReleaseResult> {
    const tag = releaseTagName(plan.nextVersion);
    const branch = releaseBranchName(plan.nextVersion);
    let releaseUrl: string | null = null;
    let prUrl: string | null = null;

    try {
        core.info(`Step 1/8: Bumping versions to ${plan.nextVersion}`);
        const bumped = await bumpVersion(plan, deps.workspaceRoot);
        core.info(`  bumped ${bumped.files.length} file(s)`);

        core.info(`Step 2/8: Writing CHANGELOG.md`);
        const changelog = await writeChangelog(plan, deps.workspaceRoot);
        core.info(`  wrote ${changelog.files.length} file(s)`);

        if (plan.isDryRun) {
            core.info('Dry run: skipping git/GitHub writes.');
            await tryPostCompletion(plan, deps.octokit, {
                releaseUrl: null,
                prUrl: null,
                dryRun: true,
            });
            return {
                success: true,
                nextVersion: plan.nextVersion,
                tagName: tag,
                releaseUrl: null,
                prUrl: null,
                error: null,
                isDryRun: true,
            };
        }

        core.info(`Step 3/8: Commit + tag on ${branch}`);
        const git = await commitAndTag(plan, deps.workspaceRoot, deps.git ? { git: deps.git } : {});
        core.info(`  branch=${git.branch} tag=${git.tag} sha=${git.commitSha}`);

        core.info(`Step 4/8: Creating GitHub release`);
        const rel = await createGitHubRelease(plan, deps.octokit);
        releaseUrl = rel.releaseUrl;
        core.info(`  ${releaseUrl}`);

        core.info(`Step 5/8: Opening changelog PR`);
        let prError: string | null = null;
        try {
            const pr = await openReleasePR(plan, deps.octokit);
            prUrl = pr.prUrl;
            core.info(`  ${prUrl}`);
        } catch (err) {
            // The tag + GitHub release are already public at this point. A PR
            // failure (commonly: org/repo "Allow GitHub Actions to create PRs"
            // toggle is off) is annoying but doesn't undo the release. Surface
            // it clearly and let the user open the PR manually.
            prError = err instanceof Error ? err.message : String(err);
            core.warning(`Could not open changelog PR: ${prError}`);
            if (/not permitted/i.test(prError)) {
                core.warning(
                    'Enable "Allow GitHub Actions to create and approve pull requests" at ' +
                        'Settings → Actions → General → Workflow permissions (repo AND org if applicable), ' +
                        'then open the PR manually from the pushed release branch.',
                );
            }
        }

        core.info(`Step 6/8: Posting completion comment`);
        await tryPostCompletion(plan, deps.octokit, {
            releaseUrl,
            prUrl,
            dryRun: false,
            ...(prError ? { prError } : {}),
        });

        core.setOutput('version', plan.nextVersion);
        core.setOutput('tag', tag);
        core.setOutput('release_url', releaseUrl);
        core.setOutput('pr_url', prUrl);

        return {
            success: true,
            nextVersion: plan.nextVersion,
            tagName: tag,
            releaseUrl,
            prUrl,
            error: null,
            isDryRun: false,
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        core.error(`Release failed: ${message}`);
        await tryPostCompletion(plan, deps.octokit, {
            releaseUrl,
            prUrl,
            dryRun: plan.isDryRun,
            error: message,
        });
        return {
            success: false,
            nextVersion: plan.nextVersion,
            tagName: tag,
            releaseUrl,
            prUrl,
            error: message,
            isDryRun: plan.isDryRun,
        };
    }
}

/**
 * Wrap `postCompletionComment` so a failure here (missing `issues: write`
 * permission, transient API hiccup) doesn't tank an otherwise-successful
 * release. Logs a warning and returns. The release-result decision is made
 * upstream based on whether the actual release steps succeeded.
 */
async function tryPostCompletion(
    plan: Parameters<typeof postCompletionComment>[0],
    octokit: Parameters<typeof postCompletionComment>[1],
    ctx: Parameters<typeof postCompletionComment>[2],
): Promise<void> {
    try {
        await postCompletionComment(plan, octokit, ctx);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        core.warning(
            `Could not post completion comment (release itself was not affected): ${message}. ` +
                'If you see "Resource not accessible by integration", add `issues: write` to your workflow permissions.',
        );
    }
}
