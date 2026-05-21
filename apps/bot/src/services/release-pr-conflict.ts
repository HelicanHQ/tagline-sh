import { releaseBranchName } from '@tagline-sh/shared';
import type { ReleasePlan } from '@tagline-sh/shared';

/**
 * Bot-side pre-flight: refuse to dispatch a release workflow when a release
 * PR is already open for the same version.
 *
 * The action's `reconcileReleaseBranch` is the race-safe authority (it
 * handles the case where two dispatches arrive back-to-back). This bot-side
 * check exists for UX: users see a friendly "PR #N is already open" comment
 * on the release-tracking issue **without** burning CI minutes on a
 * guaranteed-fail dispatch.
 *
 * Both checks are intentional; one without the other isn't enough.
 */
export interface ConflictCheckOctokit {
    rest: {
        pulls: {
            list: (params: {
                owner: string;
                repo: string;
                head: string;
                state?: 'open' | 'closed' | 'all';
            }) => Promise<{
                data: Array<{
                    number: number;
                    html_url: string;
                }>;
            }>;
        };
    };
}

export interface OpenReleasePR {
    number: number;
    url: string;
    branch: string;
}

export async function findOpenReleasePR(
    plan: ReleasePlan,
    octokit: ConflictCheckOctokit,
): Promise<OpenReleasePR | null> {
    const branch = releaseBranchName(plan.nextVersion);
    // `head: owner:branch` scopes the search to a specific head ref. Without
    // the `owner:` prefix the API does substring matching across all heads.
    const res = await octokit.rest.pulls.list({
        owner: plan.repoOwner,
        repo: plan.repoName,
        head: `${plan.repoOwner}:${branch}`,
        state: 'open',
    });
    const pr = res.data[0];
    if (!pr) return null;
    return { number: pr.number, url: pr.html_url, branch };
}
