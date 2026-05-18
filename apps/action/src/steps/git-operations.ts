import { simpleGit, type SimpleGit } from 'simple-git';
import { BOT_GIT_IDENTITY, releaseBranchName, releaseTagName } from '@tagline-sh/shared';
import type { ReleasePlan } from '@tagline-sh/shared';

export interface GitOpsResult {
    branch: string;
    tag: string;
    commitSha: string;
}

export interface GitOpsDeps {
    /** Inject a SimpleGit instance for tests. Defaults to one rooted at CWD. */
    git?: SimpleGit;
    /** Set true to skip `git push` (used by dry-run). */
    skipPush?: boolean;
}

/**
 * Configure bot identity, stage all changes, commit (with `[skip ci]` to
 * avoid CI loops), create an annotated tag, and push both branch and tag.
 *
 * The release commit lands on a new branch `release/vX.Y.Z`, not on the
 * production branch — the action's PR step opens a PR from there. This
 * preserves branch protections.
 */
export async function commitAndTag(
    plan: ReleasePlan,
    workspaceRoot: string,
    deps: GitOpsDeps = {},
): Promise<GitOpsResult> {
    const git = deps.git ?? simpleGit({ baseDir: workspaceRoot });

    await git.addConfig('user.name', BOT_GIT_IDENTITY.name);
    await git.addConfig('user.email', BOT_GIT_IDENTITY.email);

    const branch = releaseBranchName(plan.nextVersion);
    const tag = releaseTagName(plan.nextVersion);

    // Refuse to overwrite an existing tag — idempotency safeguard (PLAN.md §20).
    const tags = await git.tags();
    if (tags.all.includes(tag)) {
        throw new Error(
            `Tag ${tag} already exists. Has this release already been triggered?`,
        );
    }

    await git.checkoutLocalBranch(branch);
    await git.add(['-A']);

    const commitMessage = `chore(release): ${tag} [skip ci]`;
    const commit = await git.commit(commitMessage);

    await git.addAnnotatedTag(tag, `Release ${tag}`);

    if (!deps.skipPush) {
        await git.push(['-u', 'origin', branch]);
        await git.push(['origin', tag]);
    }

    return { branch, tag, commitSha: commit.commit };
}
