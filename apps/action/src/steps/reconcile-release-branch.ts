import * as core from '@actions/core';
import { releaseBranchName } from '@tagline-sh/shared';
import type { ReleasePlan } from '@tagline-sh/shared';

/**
 * Pre-flight branch state reconciliation for Phase A.
 *
 * The bug this exists to fix: `commitAndPushBranch` does a plain `git push -u
 * origin release/v<ver>`. If a previous run pushed that branch and then
 * failed mid-flow (network blip, Octokit 5xx, AI hiccup), the orphan branch
 * stays behind on the remote. The next retry creates a fresh local commit
 * on top of `main`, tries to push, and gets rejected as a non-fast-forward
 * because the remote tip is not an ancestor of the new commit.
 *
 * This module checks the remote state via Octokit *before* the push happens
 * and either clears the way (orphan branch → delete) or hard-fails with a
 * descriptive error (legitimate in-flight PR → don't touch).
 *
 * Mirrors the three-layer idempotency built into `ensureOnboardingPR` —
 * branches and PRs in mid-states are common, swallowing them silently is
 * dangerous, ignoring them is also dangerous; the third option is explicit
 * reconciliation with a clear policy per state.
 */
export interface ReconcileOctokit {
    rest: {
        repos: {
            getBranch: (params: {
                owner: string;
                repo: string;
                branch: string;
            }) => Promise<unknown>;
        };
        pulls: {
            list: (params: {
                owner: string;
                repo: string;
                head: string;
                state?: 'open' | 'closed' | 'all';
            }) => Promise<{
                data: Array<{
                    number: number;
                    state: string;
                    html_url: string;
                }>;
            }>;
        };
        git: {
            deleteRef: (params: {
                owner: string;
                repo: string;
                ref: string;
            }) => Promise<unknown>;
        };
    };
}

/**
 * Thrown when a release PR is already open on the branch we're about to
 * push. The executor catches this and turns the message into the failure
 * comment users see on the release-tracking issue, so the wording here is
 * intentionally user-facing.
 */
export class OpenReleasePRConflictError extends Error {
    public readonly prNumber: number;
    public readonly prUrl: string;
    public readonly branch: string;
    constructor(prNumber: number, prUrl: string, branch: string) {
        super(
            `Release PR #${prNumber} is already open for branch \`${branch}\`. ` +
                `Merge or close it before re-approving — ${prUrl}`,
        );
        this.name = 'OpenReleasePRConflictError';
        this.prNumber = prNumber;
        this.prUrl = prUrl;
        this.branch = branch;
    }
}

export interface ReconcileResult {
    branch: string;
    /** True when no remote branch existed at all (fresh-push path). */
    branchAbsent: boolean;
    /** True when an orphan branch was deleted to clear the way for push. */
    orphanReclaimed: boolean;
}

export async function reconcileReleaseBranch(
    plan: ReleasePlan,
    octokit: ReconcileOctokit,
): Promise<ReconcileResult> {
    const branch = releaseBranchName(plan.nextVersion);

    if (!(await branchExistsOnRemote(plan.repoOwner, plan.repoName, branch, octokit))) {
        return { branch, branchAbsent: true, orphanReclaimed: false };
    }

    // `head: owner:branch` is the documented way to scope a PR search to a
    // specific cross-repo head ref. For same-repo PRs the `owner:` prefix is
    // technically optional but always accepted, and being explicit avoids
    // surprises if the search ever sees forked-branch PRs.
    const res = await octokit.rest.pulls.list({
        owner: plan.repoOwner,
        repo: plan.repoName,
        head: `${plan.repoOwner}:${branch}`,
        state: 'open',
    });
    const openPR = res.data[0];
    if (openPR) {
        throw new OpenReleasePRConflictError(openPR.number, openPR.html_url, branch);
    }

    core.info(
        `Reconciler: orphan branch \`${branch}\` found from a prior partial run; ` +
            `deleting before push.`,
    );
    await octokit.rest.git.deleteRef({
        owner: plan.repoOwner,
        repo: plan.repoName,
        ref: `heads/${branch}`,
    });
    return { branch, branchAbsent: false, orphanReclaimed: true };
}

async function branchExistsOnRemote(
    owner: string,
    repo: string,
    branch: string,
    octokit: ReconcileOctokit,
): Promise<boolean> {
    try {
        await octokit.rest.repos.getBranch({ owner, repo, branch });
        return true;
    } catch (err) {
        if (isStatus(err, 404)) return false;
        throw err;
    }
}

function isStatus(err: unknown, status: number): boolean {
    return (
        typeof err === 'object' &&
        err !== null &&
        'status' in err &&
        (err as { status?: number }).status === status
    );
}
