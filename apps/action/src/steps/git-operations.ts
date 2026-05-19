import { simpleGit, type SimpleGit } from 'simple-git';
import { BOT_GIT_IDENTITY, releaseBranchName, releaseTagName } from '@tagline-sh/shared';
import type { ReleasePlan } from '@tagline-sh/shared';

export interface GitOpsResult {
    branch: string;
    /**
     * For single-repo: the single `vX.Y.Z` tag created.
     * For monorepos: a comma-joined list of all per-package tags pushed
     *   (e.g. `@acme/api@1.5.0, @acme/ui@0.4.1`). Useful for log lines and
     *   the completion comment; structured access lives on `tags[]`.
     */
    tag: string;
    /** Every tag that was created and pushed in this release event. */
    tags: string[];
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
 * avoid CI loops), create annotated tag(s), and push both branch and tag(s).
 *
 * Single-repo: one tag `vX.Y.Z` for the whole release.
 *
 * Monorepo (M3): one tag PER package using Changesets convention
 * (`@scope/name@1.5.0` or `name@1.5.0`). The bot pre-computes these names
 * on `plan.packages[*].tagName`; the action just pushes them verbatim.
 * If ANY package's tag already exists we refuse the whole release — a
 * partial monorepo release would leave the repo in an inconsistent state
 * where some packages shipped and others didn't.
 *
 * The release commit lands on a new branch (`release/vX.Y.Z` for single-repo,
 * `release/vevent-YYYY-MM-DD` for monorepo). The action's PR step opens a PR
 * from there. Preserves branch protections.
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
    const desiredTags: string[] =
        plan.packages.length > 0
            ? plan.packages.map((p) => p.tagName)
            : [releaseTagName(plan.nextVersion)];

    // Idempotency safeguard (PLAN.md §20): refuse to overwrite ANY existing
    // tag. Checking up-front means we either ship the whole release event or
    // none of it — no half-shipped monorepo state.
    const existing = await git.tags();
    const conflicts = desiredTags.filter((t) => existing.all.includes(t));
    if (conflicts.length > 0) {
        if (conflicts.length === 1) {
            throw new Error(
                `Tag ${conflicts[0]} already exists. Has this release already been triggered?`,
            );
        }
        throw new Error(
            `Tags already exist: ${conflicts.join(', ')}. Has this release already been triggered?`,
        );
    }

    await git.checkoutLocalBranch(branch);
    await git.add(['-A']);

    // Commit message names the first tag for single-repo, the event id for
    // monorepo. Both are useful at a glance in `git log`.
    const commitTag =
        plan.packages.length > 0 ? releaseTagName(plan.nextVersion) : desiredTags[0]!;
    const commitMessage = `chore(release): ${commitTag} [skip ci]`;
    const commit = await git.commit(commitMessage);

    for (const tag of desiredTags) {
        await git.addAnnotatedTag(tag, `Release ${tag}`);
    }

    if (!deps.skipPush) {
        await git.push(['-u', 'origin', branch]);
        for (const tag of desiredTags) {
            await git.push(['origin', tag]);
        }
    }

    return {
        branch,
        tag: desiredTags.join(', '),
        tags: desiredTags,
        commitSha: commit.commit,
    };
}
