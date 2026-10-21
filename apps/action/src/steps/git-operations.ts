import { simpleGit, type SimpleGit } from 'simple-git';
import { BOT_GIT_IDENTITY, releaseBranchName, releaseDisplayName } from '@tagline-sh/shared';
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

    // Commit message names the release — for single-repo this is the semver
    // version, for monorepo this is the issue-keyed event identifier.
    const releaseName = releaseDisplayName(plan.nextVersion);
    const commit = await git.commit(`chore(release): ${releaseName} [skip ci]`);

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
            getRef: (params: {
                owner: string;
                repo: string;
                ref: string;
            }) => Promise<{ data: { object: { sha: string; type?: string } } }>;
            getTag: (params: {
                owner: string;
                repo: string;
                tag_sha: string;
            }) => Promise<{ data: { object: { sha: string; type: string } } }>;
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
 * Create one ref per tag at `sha` via the GitHub API. Existing tags are only
 * idempotent when they resolve to the same commit; a tag at another commit is
 * a release-integrity conflict and fails before any missing tags are written.
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
    const missing: string[] = [];

    for (const tag of input.tags) {
        const existingSha = await resolveTagCommit(input.repoOwner, input.repoName, tag, octokit);
        if (existingSha === null) {
            missing.push(tag);
            continue;
        }
        if (existingSha !== input.sha) {
            throw tagConflict(tag, existingSha, input.sha);
        }
        skipped.push(tag);
    }

    for (const tag of missing) {
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
            if (/already exists/i.test(message)) {
                const existingSha = await resolveTagCommit(
                    input.repoOwner,
                    input.repoName,
                    tag,
                    octokit,
                );
                if (existingSha !== input.sha) {
                    throw tagConflict(tag, existingSha ?? '<missing>', input.sha);
                }
                skipped.push(tag);
                continue;
            }
            throw err;
        }
    }
    return { created, skipped };
}

async function resolveTagCommit(
    owner: string,
    repo: string,
    tag: string,
    octokit: TagMergeOctokit,
): Promise<string | null> {
    let refObject: { sha: string; type?: string };
    try {
        const ref = await octokit.rest.git.getRef({ owner, repo, ref: `tags/${tag}` });
        refObject = ref.data.object;
    } catch (err) {
        if (isStatus(err, 404)) return null;
        throw err;
    }

    if (refObject.type !== 'tag') return refObject.sha;

    const annotated = await octokit.rest.git.getTag({
        owner,
        repo,
        tag_sha: refObject.sha,
    });
    // shortcut: tag-of-tag chains fail closed; recurse here if Tagline ever creates them.
    if (annotated.data.object.type !== 'commit') {
        throw new Error(`Tag ${tag} does not resolve directly to a commit.`);
    }
    return annotated.data.object.sha;
}

function tagConflict(tag: string, actualSha: string, expectedSha: string): Error {
    return new Error(
        `Tag ${tag} already exists at ${actualSha}, expected ${expectedSha}. ` +
            'Refusing to publish a release for the wrong commit.',
    );
}

function isStatus(err: unknown, status: number): boolean {
    return (
        typeof err === 'object' &&
        err !== null &&
        'status' in err &&
        (err as { status?: number }).status === status
    );
}
