import { simpleGit, type SimpleGit } from 'simple-git';
import { BOT_GIT_IDENTITY, releaseBranchName, releaseTagName } from '@tagline-sh/shared';
import type { ReleasePlan } from '@tagline-sh/shared';

export interface CommitAndPushResult {
    branch: string;
    commitSha: string;
}

export interface GitOpsDeps {
    /** Inject a SimpleGit instance for tests. Defaults to one rooted at CWD. */
    git?: SimpleGit;
    /** Set true to skip `git push` (used by dry-run). */
    skipPush?: boolean;
}

/**
 * Phase A — propose.
 *
 * Configure bot identity, stage all changes, commit (with `[skip ci]` to
 * avoid CI loops), and push the release branch. **No tag is created here.**
 *
 * Why no tag in this phase: the tag marks shipped code. The release branch
 * is a *proposal* — it's not shipped until the PR is merged. Creating the
 * tag before merge means:
 *
 *   1. A "released" version exists that isn't on `main` — `git describe`
 *      against `main` would show stale info.
 *   2. Closing the PR without merging leaves a dangling tag on a commit
 *      that no branch points at.
 *   3. The GitHub Release goes public before any human approval.
 *
 * The tag is created by `tagMergeCommit` in Phase B, after the PR merges.
 */
export async function commitAndPushBranch(
    plan: ReleasePlan,
    workspaceRoot: string,
    deps: GitOpsDeps = {},
): Promise<CommitAndPushResult> {
    const git = deps.git ?? simpleGit({ baseDir: workspaceRoot });

    await git.addConfig('user.name', BOT_GIT_IDENTITY.name);
    await git.addConfig('user.email', BOT_GIT_IDENTITY.email);

    const branch = releaseBranchName(plan.nextVersion);

    await git.checkoutLocalBranch(branch);
    await git.add(['-A']);

    // Commit message names the event tag — for single-repo this is the
    // semver version, for monorepo this is the date-keyed event identifier.
    const headlineTag = releaseTagName(plan.nextVersion);
    const commit = await git.commit(`chore(release): ${headlineTag} [skip ci]`);

    if (!deps.skipPush) {
        await git.push(['-u', 'origin', branch]);
    }

    return { branch, commitSha: commit.commit };
}

export interface TagMergeCommitInput {
    repoOwner: string;
    repoName: string;
    /** SHA the tag(s) should point at — typically the PR's merge_commit_sha. */
    sha: string;
    /** Every tag name to create. Single-repo: 1 tag. Monorepo: N tags. */
    tags: string[];
}

export interface TagMergeOctokit {
    rest: {
        git: {
            createRef: (params: {
                owner: string;
                repo: string;
                ref: string;
                sha: string;
            }) => Promise<{ data: { ref: string } }>;
            getRef?: (params: {
                owner: string;
                repo: string;
                ref: string;
            }) => Promise<{ data: { object: { sha: string } } }>;
        };
    };
}

export interface TagMergeResult {
    /** Tags that were newly created in this run. */
    created: string[];
    /** Tags that already existed and were skipped (idempotency). */
    skipped: string[];
}

/**
 * Phase B — finalize.
 *
 * Create one annotated-ref per tag at `sha` via the GitHub API. Skips tags
 * that already exist (idempotent re-runs).
 *
 * Why Octokit instead of simple-git: in Phase B the workspace may not even
 * be checked out at the right SHA — `pull_request: closed` doesn't auto-
 * checkout the merge commit. Tagging via the API only requires the SHA,
 * which the event payload hands us.
 */
export async function tagMergeCommit(
    input: TagMergeCommitInput,
    octokit: TagMergeOctokit,
): Promise<TagMergeResult> {
    const created: string[] = [];
    const skipped: string[] = [];
    for (const tag of input.tags) {
        try {
            await octokit.rest.git.createRef({
                owner: input.repoOwner,
                repo: input.repoName,
                ref: `refs/tags/${tag}`,
                sha: input.sha,
            });
            created.push(tag);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // GitHub returns 422 "Reference already exists" when the tag is
            // already there. Treat as idempotent skip; surface anything else.
            if (/already exists/i.test(message)) {
                skipped.push(tag);
                continue;
            }
            throw err;
        }
    }
    return { created, skipped };
}
